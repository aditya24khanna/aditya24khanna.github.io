# Personal portfolio

A static, single-page portfolio for GitHub Pages. No build step and no framework: plain HTML, CSS and a small script that renders each section from a JSON file.

## Structure

```
.
├── index.html            # Page shell: nav, 8 sections, footer
├── ask.html              # Reserved for an AI "ask me" page (hidden until enabled)
├── 404.html              # Not-found page
├── favicon.svg
├── robots.txt
├── .nojekyll             # Tells GitHub Pages to serve files as-is
├── assets/
│   ├── css/
│   │   ├── tokens.css    # Colours, fonts, sizes. Restyle the site here.
│   │   └── main.css      # Layout and components
│   ├── js/
│   │   └── main.js       # Loads /data/*.json and renders the sections
│   ├── img/              # Profile photo, social preview image
│   └── fonts/            # Self-hosted fonts, if any
└── data/                 # All content lives here
    ├── site.json         # Name, role, summary, links, contact, footer
    ├── metrics.json      # Headline numbers
    ├── experience.json   # Roles, newest first
    ├── case-studies.json # Problem → approach → result
    ├── projects.json     # Side projects and experiments
    ├── writing.json      # Posts, talks, publications
    ├── about.json        # Longer bio and education
    └── _examples/        # The shape of each file
```

## Sections

| # | Section      | Anchor        | Data file           |
|---|--------------|---------------|---------------------|
| 1 | Hero         | `#top`        | `site.json`         |
| 2 | Impact       | `#impact`     | `metrics.json`      |
| 3 | Experience   | `#experience` | `experience.json`   |
| 4 | Case studies | `#work`       | `case-studies.json` |
| 5 | Projects     | `#projects`   | `projects.json`     |
| 6 | Writing      | `#writing`    | `writing.json`      |
| 7 | About        | `#about`      | `about.json`        |
| 8 | Contact      | `#contact`    | `site.json` → `contact` |

A section stays hidden until its data file has content, and the nav only lists visible sections. You can publish the site empty and fill it in one section at a time.

## Edit content

Change the JSON files in `/data`. `data/_examples/README.md` shows the shape of each one. Commit, and GitHub Pages redeploys in about a minute.

## Preview locally

The page loads JSON with `fetch`, which browsers block on `file://`. Run a local server instead:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

Settings → Pages → Source: "Deploy from a branch" → `main` / `(root)`.
