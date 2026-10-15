// Formats agent/settings.json exactly as pi writes it (`JSON.stringify(value, null, 2)`, no
// final newline), so pi rewriting the file does not fight the formatter.
for (const path of process.argv.slice(2)) {
  const text = await Bun.file(path).text();
  const formatted = JSON.stringify(JSON.parse(text), null, 2);
  if (formatted !== text) {
    await Bun.write(path, formatted);
  }
}

export {};
