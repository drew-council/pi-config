{ ... }:
{
  projectRootFile = "flake.nix";

  programs = {
    biome = {
      enable = true;
      formatCommand = "format";
      settings = {
        formatter = {
          enabled = true;
          indentStyle = "space";
          indentWidth = 2;
          lineWidth = 120;
        };
        javascript.formatter.quoteStyle = "double";
      };
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
}
