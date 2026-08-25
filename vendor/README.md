# Vendored packages

## xlsx-0.20.3.tgz (SheetJS)

Vendored on purpose: the public npm registry stopped at `xlsx@0.18.5`, which is
vulnerable to CVE-2023-30533 (prototype pollution, fixed in 0.19.3) and
CVE-2024-22363 (ReDoS, fixed in 0.20.2). 0.20.3 covers both.

- Origin: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
- sha256 (first 16 hex): `8dc73fc3b00203e7`
- Integrity is pinned in `package-lock.json` — do not remove the `integrity`
  field, and verify the checksum against cdn.sheetjs.com before any update so
  the tarball cannot be swapped silently.
