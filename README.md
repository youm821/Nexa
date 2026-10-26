# Nexora

Moderation bot for Yapper + web dashboard, in one Node.js process (no dependencies).

## Deploy on Render (always on)
1. Create a GitHub repo and upload everything in this folder (not `.env`).
2. Render dashboard -> **New -> Blueprint** -> pick the repo. It reads `render.yaml`.
3. Enter `TOKEN` (Yapper bot token) and `OWNER_PASSWORD` when asked. Deploy.
4. Open `https://<your-service>.onrender.com`. Logs should say "Logged in as ..." and "ModBot ready".

Cost: Starter instance (~$7/mo) + 1 GB disk (~$0.25/mo). The free plan sleeps after
15 minutes without web traffic, which switches the bot off, and free services cannot
attach a disk, so warnings and settings would be wiped on restart.

## How users log in
Server staff open the site -> **Log in with a code** -> type `!link NX-123456` in their server.
Only people with Manage Server (or the owner) can link. The login is tied to that one
server: the dashboard has no way to read or change any other server.

## Owner dashboard
`https://<your-site>/owner`, password = `OWNER_PASSWORD`. Shows servers, activity, blacklist
and announcements (sent to each server's mod-log channel).

## Run locally
Copy `.env.example` to `.env`, fill it in, `npm start`, open http://localhost:3000
