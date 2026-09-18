local channel, lines, row, byte_col = ...

-- Pi renders the active mode in its editor border. Omit Neovim's redundant
-- statusline and mode row; command-line and message presentation is handled
-- below because the prompt grid is intentionally compact.
vim.o.laststatus = 0
vim.o.showmode = false
vim.o.ruler = false
vim.o.cmdheight = 0

-- The embedded grid is only as tall as the prompt, so Neovim's native message
-- rendering would overwrite the buffer content and hide the actual text behind
-- its "Press ENTER or type command to continue" hit-enter prompt. Intercept
-- messages and forward them to Pi's notification system instead. Message
-- history (:messages) is unaffected; the command line remains available.
local function message_text(content)
  local chunks = {}
  for _, chunk in ipairs(content) do
    chunks[#chunks + 1] = tostring(chunk[2] or "")
  end
  return table.concat(chunks):gsub("\r\n?", "\n")
end

local message_namespace = vim.api.nvim_create_namespace("PiMessages")
local message_ok, message_error = pcall(vim.ui_attach, message_namespace, { ext_messages = true }, function(event, ...)
  -- ext_messages also externalizes the command line. Keep it in Pi's final
  -- grid row, while forwarding the otherwise hidden messages as notifications.
  if event == "cmdline_show" then
    local content, pos, firstc, prompt, indent, level = ...
    local prefix = (firstc ~= "" and firstc) or prompt or ""
    local text = prefix .. string.rep(" ", indent or 0) .. message_text(content)
    vim.rpcnotify(channel, "pi_cmdline_show", text, (pos or 0) + #prefix + (indent or 0), level or 1)
  elseif event == "cmdline_pos" then
    local pos, level = ...
    vim.rpcnotify(channel, "pi_cmdline_pos", pos or 0, level or 1)
  elseif event == "cmdline_hide" then
    local level = ...
    vim.rpcnotify(channel, "pi_cmdline_hide", level or 1)
  elseif event == "msg_show" then
    local kind, content = ...
    local text = message_text(content)
    -- kind "return_prompt" is the empty hit-enter prompt itself; the message
    -- that triggered it was already forwarded.
    if text ~= "" and kind ~= "return_prompt" then
      vim.rpcnotify(channel, "pi_message", text, kind)
    end
  end
end)
if not message_ok then
  vim.schedule(function()
    vim.rpcnotify(channel, "pi_message", "Message interception unavailable: " .. tostring(message_error), "wmsg")
  end)
end

local buffer = vim.api.nvim_create_buf(false, true)
vim.g.pi_prompt_buffer = buffer
vim.api.nvim_buf_set_name(buffer, "[Pi Prompt]")
vim.bo[buffer].bufhidden = "hide"
vim.bo[buffer].swapfile = false
vim.bo[buffer].undofile = false
vim.bo[buffer].filetype = "markdown"
vim.api.nvim_set_current_buf(buffer)
vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
vim.api.nvim_win_set_cursor(0, { row + 1, byte_col })
vim.api.nvim_buf_create_user_command(buffer, "PiSubmit", function()
  vim.rpcnotify(channel, "pi_submit")
end, { desc = "Submit the current prompt to Pi" })

-- `:Pb` (typed as `:pb` through the command-line abbreviation below; user
-- commands must start with an uppercase letter) wraps the clipboard in a
-- fenced Markdown code block below the current line. The clipboard is the
-- `+` register (`*` is the primary selection, used as a fallback); an
-- optional argument names the fence language, e.g. `:Pb lua`.
vim.api.nvim_buf_create_user_command(buffer, "Pb", function(opts)
  local text = vim.fn.getreg("+")
  if text == "" then
    text = vim.fn.getreg("*")
  end
  if text == "" then
    vim.api.nvim_echo({ { "pb: clipboard (+ register) is empty", "WarningMsg" } }, true, {})
    return
  end
  local block = vim.split(text, "\r?\n")
  while #block > 0 and block[#block] == "" do
    table.remove(block)
  end
  local lines = { "", "```" .. (opts.args or "") }
  for _, line in ipairs(block) do
    lines[#lines + 1] = line
  end
  lines[#lines + 1] = "```"
  lines[#lines + 1] = ""
  local row = vim.api.nvim_win_get_cursor(0)[1]
  vim.api.nvim_buf_set_lines(buffer, row, row, false, lines)
  -- Continue typing on the blank line after the block.
  vim.api.nvim_win_set_cursor(0, { row + #lines, 0 })
  local normalize = _G.pi_normalize_prompt_viewport
  if type(normalize) == "function" then
    normalize()
  end
  vim.rpcnotify(channel, "pi_state_dirty")
end, { nargs = "?", desc = "Wrap the clipboard in a Markdown code block below the current line" })
-- Expansion happens when a non-keyword character (including Enter) is typed,
-- so `:pb`, `:pb json` (as `:pb<Space>json`), and `:Pb` all work.
vim.cmd.cnoreabbrev("pb Pb")

-- Pi grows the external UI to the prompt's rendered height. Neovim's view
-- clamping leaves '~' filler rows below the last line whenever the window is
-- taller than the content between the view's top line and the buffer end,
-- which wastes prompt rows. The viewport is therefore normalized so the last
-- line's final screen row sits exactly on the window's bottom row, letting the
-- view top start mid-line ('smoothscroll' keeps that state across redraws).
-- Reassert scrolloff because user configuration may set it for every window or
-- markdown buffer.
vim.wo.smoothscroll = true

local normalizing_viewport = false
local function rows_to_end(from_line, last_line)
  if from_line > last_line then
    return 0
  end
  return vim.api.nvim_win_text_height(0, { start_row = from_line - 1, end_row = last_line - 1 }).all
end

local function normalize_viewport()
  local window = vim.fn.bufwinid(buffer)
  if window == -1 or not vim.api.nvim_win_is_valid(window) then
    return
  end

  vim.wo[window].scrolloff = 0
  if normalizing_viewport then
    return
  end

  normalizing_viewport = true
  pcall(vim.api.nvim_win_call, window, function()
    local last_line = vim.fn.line("$")
    local height = vim.api.nvim_win_get_height(0)
    -- Where does the last line's final screen row sit right now?
    local eof_row = vim.fn.screenpos(0, last_line, vim.fn.col({ last_line, "$" })).row
    if eof_row == 0 or eof_row >= height then
      -- Either the buffer end is below the fold (the window is full of
      -- content) or it already sits on the bottom row.
      return
    end
    -- The whole buffer must be tall enough to fill the window, otherwise the
    -- dead rows cannot be filled from above.
    if rows_to_end(1, last_line) < height then
      return
    end
    -- Find the largest topline whose row span to the buffer end reaches the
    -- window height; the remainder becomes the mid-line offset of the view
    -- top. The search stays within [1, topline], so the cursor line never
    -- ends up above the view top.
    local view = vim.fn.winsaveview()
    local lo, hi = 1, view.topline
    while lo < hi do
      local mid = math.floor((lo + hi + 1) / 2)
      if rows_to_end(mid, last_line) >= height then
        lo = mid
      else
        hi = mid - 1
      end
    end
    local topfill = rows_to_end(lo, last_line) - height
    view.topline = lo
    view.topfill = topfill
    -- The mid-line offset may also be represented as a column skip of the
    -- topline ('smoothscroll'); clear it so the offset above is the only
    -- source of truth.
    view.skipcol = 0
    vim.fn.winrestview(view)
  end)
  normalizing_viewport = false
end
_G.pi_normalize_prompt_viewport = normalize_viewport
normalize_viewport()

local group = vim.api.nvim_create_augroup("PiEmbeddedPrompt", { clear = true })
vim.api.nvim_create_autocmd(
  { "TextChanged", "TextChangedI", "CursorMoved", "CursorMovedI", "ModeChanged", "BufEnter" },
  {
    group = group,
    callback = function()
      vim.rpcnotify(channel, "pi_state_dirty")
    end,
  }
)
vim.api.nvim_create_autocmd("WinScrolled", {
  group = group,
  callback = function()
    normalize_viewport()
    vim.rpcnotify(channel, "pi_state_dirty")
  end,
})
vim.api.nvim_create_autocmd("VimLeavePre", {
  group = group,
  once = true,
  callback = function()
    vim.rpcnotify(channel, "pi_exit")
  end,
})

vim.cmd.startinsert()
return buffer
