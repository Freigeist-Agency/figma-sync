# Section Sync: {{section}}

Update the `{{section}}` section (selector `{{selector}}` on page `{{page}}`) to match the latest Figma design.

1. Edit only the section's files, the tokens file and new images under assets:
{{files}}
Tokens file: {{tokens}}
Assets directory: {{assets}}
2. Read `tree.json`, `desktop.png`, `mobile.png` (present only when the section has a mobile frame) and any `fills/` in the work folder at {{workDir}}.
3. Put colours, type and spacing in the tokens file as CSS variables and reuse existing ones.
4. Re-encode image fills to the format and widths the site already uses for that section, with ImageMagick.
5. Never touch the protected list:
{{protected}}
6. `desktop.png` is the design at 1440 px wide; {{mobile}}
7. Write anything you could not match to {{workDir}}/report.md instead of guessing.
8. Do not commit.
