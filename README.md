# Aditya Khanna · Portfolio

"Graph Paper" design: a product leader's working notebook. Static site for GitHub Pages: plain HTML, CSS and one script that renders every section from JSON. No build step.

## Structure

```
.
├── index.html             # Page shell: header, 10 sections, footer, lightbox
├── ask.html               # Reserved for a future AI chat page
├── 404.html
├── robots.txt
├── .nojekyll
├── assets/
│   ├── css/
│   │   ├── tokens.css     # Colours, fonts, highlighter, light + dark
│   │   └── main.css       # Layout and components
│   ├── js/
│   │   └── main.js        # Loads /data and renders sections, tabs, demo, gallery, theme toggle
│   └── img/
│       └── avatar.svg     # Illustrated avatar (placeholder until drawn from a real photo)
└── data/                  # All content lives here
    ├── site.json          # Name, role, tagline, hero, stats, worked-at, nav, contact, footer
    ├── case-studies.json  # Tabs; set "locked": true for confidential ones
    ├── screens.json       # Shipped-screens gallery (sample phone mockups for now)
    ├── experience.json    # Roles, newest first
    ├── ai.json            # Workflow demo + AI project cards
    ├── principles.json    # Three operating principles
    ├── toolbox.json       # Four columns; "personal": true styles the last one
    └── education.json
```

## Sections

| # | Section | Anchor | Data |
|---|---|---|---|
| 1 | Header (avatar, name, role, links, dark-mode toggle, Contact) | — | `site.json` |
| 2 | Hero | `#top` | `site.json` → `tagline`, `summary`, `ctas` |
| 3 | Stats + Worked at | `#impact` | `site.json` → `stats`, `workedAt` |
| 4 | Case studies | `#work` | `case-studies.json` |
| 5 | Shipped screens | `#screens` | `screens.json` |
| 6 | Experience | `#experience` | `experience.json` |
| 7 | AI work | `#ai` | `ai.json` |
| 8 | Operating principles | `#principles` | `principles.json` |
| 9 | Toolbox | `#toolbox` | `toolbox.json` |
| 10 | Education | `#education` | `education.json` |
| 11 | Contact | `#contact` | `site.json` → `contact` |
| 12 | Footer | — | `site.json` → `footer` |

A section stays hidden until its data has content. `"sample": true` in `site.json` shows the red "sample content" bar; set it to `false` before launch.

## Preview locally

```
python3 -m http.server 8000
```

Open http://localhost:8000. (Opening `index.html` directly won't load the JSON.)
