# HackSphere — Aavishkar ’26 Ideathon

Responsive hackathon event portal for Ideathon at Government College of Engineering, Karad. The public site includes event information, domains, prizes, FAQs, a submission form, and an authenticated organiser/judge workspace with search, domain filters, sorting, counts and private PPT downloads.

## Run locally

Install Node.js 20 or later, then run `node server.mjs` from this folder and open `http://localhost:8000`. The form posts directly to the included server.

## Deploy with Docker

This project includes a production container and a persistent Docker volume for uploaded decks and platform data.

1. Copy `.env.example` to `.env` and replace `ADMIN_TOKEN` with a unique secret. For example, generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
2. Run `docker compose up --build -d`.
3. Configure your hosting provider's HTTPS domain or reverse proxy to port `8000`. Keep the `ideathon-data` volume attached across redeploys and back it up.
4. Open `/` for the public event page and `/judges` for organizer sign-in. The sign-in password is the configured `ADMIN_TOKEN`.

The included `docker-compose.yml` is suitable for a Docker host with persistent volumes. The application has no managed database or cloud file storage configured, so use a host that preserves Docker volumes and handles HTTPS. Do not publish the organizer password in source control or send it to participants.

## Where submissions are saved

Each accepted entry is stored in `private-submissions/<submission-id>/`:

- `submission.json` contains the team details, chosen domain, idea summary, timestamp and original upload name.
- `presentation.ppt` or `presentation.pptx` contains the uploaded deck.

This folder is excluded from Git and is not served by the website. Set `SUBMISSIONS_DIR` to choose a different persistent storage folder. Keep backups and restrict access to the machine or disk that holds these files.

Open `http://localhost:8000/judges` to review entries and download each team’s original PPT. The organizer sign-in currently accepts the shared organizer password stored in `private-submissions/.organizer-token` (or `ADMIN_TOKEN` if configured). This is a server-generated shared password, not a personal username/password account system. Do not show it to participants. In the organizer workspace, open **Announcements** and choose **Delete announcement** on the item to remove it from both the workspace and public homepage. Participant passwords are not available because participant accounts have not been implemented; participants use the public idea submission form. The public submission form accepts PowerPoint files up to 20 MB, validates file extension and MIME type on the server, applies a basic per-address rate limit, and stores records and decks in private local folders.

## Current scope

This is a lightweight Node.js application with no third-party runtime dependencies. Submissions are stored as private JSON records and local files, not PostgreSQL/MongoDB or cloud storage. Email/SMS OTP, Google sign-in, individual student/judge/mentor accounts, chat, automated notifications, mentor workflows and certificate generation are not configured. Add a production identity provider, durable database, object storage, TLS and deployment-specific security controls before using it for a large public event.

## Before launch

- Replace or approve the editable round-one deck at `assets/ideathon-round-one-template.pptx` before official launch.
- Event dates are not announced yet; publish the confirmed schedule in the noticeboard when ready.
- For public hosting, use a persistent private disk or cloud object storage for `SUBMISSIONS_DIR`; ephemeral hosting filesystems can be cleared during redeploys.
- Configure HTTPS, a strong `ADMIN_TOKEN`, persistent private storage, routine backups, and a retention/access process before sharing the form publicly.
- The rulebook, listed domains, round fees, prizes, and organiser contacts are reflected on the page; confirm any final wording with the event organisers.
