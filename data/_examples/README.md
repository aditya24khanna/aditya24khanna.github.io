# Data file shapes

Copy an entry into the matching file in `/data` and fill it in. A section stays hidden until its file has at least one entry.

## site.json
`links` and `contact.links` are lists of `{ "label": "LinkedIn", "url": "https://..." }`.
`photo` is a path such as `assets/img/profile.jpg`.
Set `features.ask` to `true` to show the "Ask me" button (links to `ask.html`).

## metrics.json
```json
[{ "value": "", "label": "" }]
```

## experience.json (newest first)
```json
[{ "period": "", "title": "", "org": "", "summary": "", "highlights": [""] }]
```

## case-studies.json and projects.json
```json
[{ "meta": "", "title": "", "problem": "", "approach": "", "result": "", "url": "", "linkLabel": "" }]
```

## writing.json
```json
[{ "date": "", "title": "", "summary": "", "url": "" }]
```

## about.json
```json
{ "heading": "", "paragraphs": [""], "education": [{ "year": "", "degree": "", "school": "" }] }
```
