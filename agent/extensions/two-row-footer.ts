import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
  const home = homedir();
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function addUsage(totals: UsageTotals, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

/** Keep the right-hand value visible and use whatever remains for the left. */
function alignSides(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (!right) return truncateToWidth(left, width, "...");

  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "...");

  const maxLeftWidth = width - rightWidth - (left ? 1 : 0);
  const fittedLeft = truncateToWidth(left, maxLeftWidth, "...");
  const fittedLeftWidth = visibleWidth(fittedLeft);
  const padding = " ".repeat(width - fittedLeftWidth - rightWidth);
  return fittedLeft + padding + right;
}

export default function twoRowFooter(pi: ExtensionAPI) {
  let messageRevision = 0;
  pi.on("message_end", () => {
    // Finalized messages can be replaced by subsequent message_end handlers.
    messageRevision++;
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      let cachedHeader: ReturnType<typeof ctx.sessionManager.getHeader>;
      let cachedLeaf: ReturnType<typeof ctx.sessionManager.getLeafEntry>;
      let cachedRevision = -1;
      let totals: UsageTotals;
      let latestCacheHitRate: number | undefined;

      const updateUsage = () => {
        const header = ctx.sessionManager.getHeader();
        const leaf = ctx.sessionManager.getLeafEntry();
        if (header === cachedHeader && leaf === cachedLeaf && messageRevision === cachedRevision) return;

        // Public session history is append-only. Appends/context edits move the
        // leaf; identity also detects reloads and replacements with the same ID.
        // Rebuild from raw history, not the active branch: abandoned work is billed.
        cachedHeader = header;
        cachedLeaf = leaf;
        cachedRevision = messageRevision;
        totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        latestCacheHitRate = undefined;
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            addUsage(totals, entry.message.usage);
            const promptTokens =
              entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
            latestCacheHitRate = promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
          } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
            addUsage(totals, entry.message.usage);
          } else if (
            (entry.type === "branch_summary" || entry.type === "compaction" || entry.type === "usage") &&
            entry.usage
          ) {
            addUsage(totals, entry.usage);
          }
        }
      };

      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          updateUsage();

          const usageParts: string[] = [];
          const addDimUsage = (text: string) => usageParts.push(theme.fg("dim", text));
          if (totals.input) addDimUsage(`↑${formatTokens(totals.input)}`);
          if (totals.output) addDimUsage(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead) addDimUsage(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite) addDimUsage(`W${formatTokens(totals.cacheWrite)}`);
          if ((totals.cacheRead || totals.cacheWrite) && latestCacheHitRate !== undefined) {
            addDimUsage(`CH${latestCacheHitRate.toFixed(1)}%`);
          }
          if (totals.cost || ctx.model?.provider === "kimi-coding") {
            addDimUsage(`$${totals.cost.toFixed(3)}${ctx.model?.provider === "kimi-coding" ? " (sub)" : ""}`);
          }

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercent = contextUsage?.percent;
          const contextText =
            contextPercent === null
              ? `?/${formatTokens(contextWindow)} (auto)`
              : `${(contextPercent ?? 0).toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
          usageParts.push(
            contextPercent !== null && contextPercent !== undefined && contextPercent > 90
              ? theme.fg("error", contextText)
              : contextPercent !== null && contextPercent !== undefined && contextPercent > 70
                ? theme.fg("warning", contextText)
                : theme.fg("dim", contextText),
          );

          let path = formatCwd(ctx.sessionManager.getCwd());
          const branch = footerData.getGitBranch();
          if (branch) path += ` (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) path += ` • ${sessionName}`;

          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, text]) => sanitizeStatus(text))
            .filter(Boolean)
            .join(" ");

          const modelName = ctx.model?.id ?? "no-model";
          const thinkingLevel = ctx.thinkingLevel ?? "off";
          let modelDetails = ctx.model?.reasoning
            ? `${modelName} • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}`
            : modelName;
          if (ctx.model && footerData.getAvailableProviderCount() > 1) {
            modelDetails = `(${ctx.model.provider}) ${modelDetails}`;
          }

          return [
            alignSides(theme.fg("dim", path), usageParts.join(" "), width),
            alignSides(statuses, theme.fg("dim", modelDetails), width),
          ];
        },
      };
    });
  });
}
