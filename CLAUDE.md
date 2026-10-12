# Project notes

This repository is the clinic's online support chatbot (ننه پت, https://chat.enetvip.com): visitors chat at `/`,
the clinic manages everything at `/admin`. Node 22+, no npm dependencies, SQLite via `node:sqlite`; answers come
only from its own database (keyword matching, no AI). Run `npm test` in the repository root. `design/` holds the
approved HTML mock-ups and is never deployed. The booking panel (پنل نوبتی) lives in a different repository
(`alikaidkhordeh/video1`) and is not part of this one.

## Server rules (from the owner, always apply)

- Never delete anything on the server.
- The server also runs other bots and the booking panel (`~/panel-nobatdehi`). Work only inside this project's own
  folder (`~/chat-poshtibani`) and do not touch any other folder, container, service or config on the server.

## Deployment

`deploy/install.sh` installs, updates or restores the chat on the server in `~/chat-poshtibani` (code in `app/`,
database in `data/`, settings in `.env`). Default "tunnel" mode uses a Cloudflare tunnel and opens no port at all
(ports 80 and 443 on that server belong to other programs); it replaces only the DNS record of its own hostname,
and only with `CHAT_DNS_OVERWRITE=1` or the owner's "y". "direct" mode (Caddy on port 443) is for a server whose
port 443 is free. Steps for the owner are in `deploy/README.md`.
