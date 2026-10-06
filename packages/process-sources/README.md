# @bearly/process-sources

Dependency-free, stateless interpretation of process-source data. Callers own filesystem reads, deadlines, process identity and error reporting.

- `parseProcessArgv(contents)` removes one final NUL and preserves all other fields.
- `classifyProcessLink(target)` preserves path, socket, pipe, anonymous and malformed distinctions.
- `classifyProcessSourceError(error)` retains code and detail; unexpected failures remain unexpected.
- `summarizeProcessFileDescriptors(links)` counts a successful listing separately from acquired and unreadable targets. Supply one outcome per listed name. A failed directory listing is an acquisition failure, never an empty input.

No resource paths, I/O, process census, scheduling, redaction or identity policy lives here.
