{ pkgs, ... }:
{
  projectRootFile = "flake.nix";

  programs = {
    # Options and ignores live in oxfmt.config.ts, shared with ./scripts/check.nu.
    oxfmt = {
      enable = true;
      includes = [
        "*.cjs"
        "*.js"
        "*.json"
        "*.jsonc"
        "*.mjs"
        "*.ts"
      ];
      excludes = [
        "agent/extensions/herdr-agent-state.ts"
        "agent/settings.json"
      ];
    };
    dos2unix.enable = true;
    nixfmt.enable = true;
    ruff-format = {
      enable = true;
      lineLength = 120;
    };
    topiary-nushell.enable = true;
    stylua = {
      enable = true;
      settings = {
        column_width = 120;
        indent_type = "Spaces";
        indent_width = 2;
        quote_style = "AutoPreferDouble";
      };
    };
  };

  # pi rewrites this file itself; see ./scripts/format-pi-settings.ts.
  settings.formatter.pi-settings = {
    command = "${pkgs.bun}/bin/bun";
    options = [ "${./scripts/format-pi-settings.ts}" ];
    includes = [ "agent/settings.json" ];
  };
}
