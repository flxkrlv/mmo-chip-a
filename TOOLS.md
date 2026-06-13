# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

## ⚠️ Critical: Don't Kill OpenClaw!

Never kill `node.exe` or `localhost` processes related to OpenClaw.
OpenClaw runs its own gateway server — killing `node.exe` indiscriminately
takes down both the project backend AND the OpenClaw gateway.

When restarting project servers:
- Frontend (vite): `cd frontend && npx vite --host 0.0.0.0`
- Backend (tsx): `npx tsx backend/src/index.ts`
- Both run alongside OpenClaw on separate ports (3001 backend, 5173 frontend)

## Related

- [Agent workspace](/concepts/agent-workspace)
