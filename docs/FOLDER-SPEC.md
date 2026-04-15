# Documentation folder specification

This repo keeps **Markdown** and **PDF** documentation under `docs/`, separate from application code. Follow this layout when adding or moving files.

---

## Directory layout

```text
docs/
├── README.md                 ← Entry point: what lives where
├── FOLDER-SPEC.md            ← This file (conventions)
├── architecture/             ← Product / system design (canonical + exports)
│   ├── ValleyCroft_Architecture_v2.md
│   └── ValleyCroft_Architecture_v2.pdf
└── guides/                   ← Day-to-day integration and API behaviour
    ├── SYSTEM-FUNCTIONALITY.md
    ├── system-functionality.manifest.json
    ├── ACCOUNTING.md
    ├── FRONTEND-GUIDE.md
    └── CONNECTING.md
```

---

## Folder rules

| Folder | Purpose | Formats |
|--------|---------|---------|
| **`docs/architecture/`** | High-level product architecture, stakeholder PDFs, converted copies of PDFs for diffing in Git. | `.md`, `.pdf` |
| **`docs/guides/`** | How to use the API, connect clients, accounting rules, machine-readable indexes that track the API. | `.md`, `.json` |

**Do not** place documentation in `src/` except short inline comments. **Do not** commit secrets; env examples stay in `.env.example` at repo root.

---

## Naming conventions

- Use **UPPERCASE-with-hyphens** for prominent guides: `FRONTEND-GUIDE.md`, `SYSTEM-FUNCTIONALITY.md`.
- Use **PascalCase** for branded deliverables: `ValleyCroft_Architecture_v2.pdf`.
- Pair PDF + Markdown when the MD is a **text export** of the PDF (keep same basename).

---

## Cross-references

- From **`docs/architecture/*.md`** to guides: use relative paths, e.g. `../guides/SYSTEM-FUNCTIONALITY.md`.
- From **`docs/guides/*.md`** to sibling guides: `./OTHER.md`.
- From **repo root** to docs: `docs/guides/...` or `docs/architecture/...`.

---

## Adding new documents

1. Choose **`architecture/`** vs **`guides/`** using the table above.
2. Add the file; if it replaces or supplements an existing doc, add one line to **`docs/README.md`**.
3. Update any manifest or index (`system-functionality.manifest.json`) if endpoints or modules changed.
4. Prefer linking from `DOCUMENTATION.md` at repo root only as a **pointer** — keep the canonical tree under `docs/`.

---

## Root pointer

The repository root contains **`DOCUMENTATION.md`** so contributors opening the repo see where full documentation lives without hunting.
