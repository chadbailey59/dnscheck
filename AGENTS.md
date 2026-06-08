# Repository Guidelines

## Project Structure & Module Organization

The active application lives at the repository root. `backend/src/` contains the Express/Postgres API, database setup, polling logic, and configuration. `frontend/src/` contains the React/Vite UI, with `App.tsx`, `App.css`, and shared TypeScript types in `types.ts`. Deployment files are `Dockerfile` and `docker-compose.yml`. Root-level docs include `AGENTS.md` and `CLAUDE.md`.

## Build, Test, and Development Commands

- `cd backend && npm install && npm run dev`: run the backend with Node watch mode.
- `cd backend && npm start`: run the backend without watch mode.
- `cd frontend && npm install && npm run dev`: start the Vite frontend dev server.
- `cd frontend && npm run build`: type-check and build the frontend.
- `docker compose up --build`: build and run the container. Provide a matching `.env` file.

## Coding Style & Naming Conventions

Use the existing style in nearby files. Backend JavaScript uses CommonJS, semicolons, `const`/`let`, and small modules by responsibility. Frontend TypeScript uses React function components, PascalCase component names, camelCase variables, and colocated CSS in `App.css`.

## Testing Guidelines

There are no committed automated test scripts yet. For now, verify changes with the relevant build or runtime command: `npm run build` for frontend changes and backend startup for API or poller changes. When adding tests, colocate them near exercised code and add a documented command.

## Commit & Pull Request Guidelines

Git history uses short, imperative commit subjects such as `Add v2: React/Node/Postgres rewrite, replace Python/SQLite app`. Keep commits focused and mention the affected area when helpful.

Pull requests should include a concise summary, commands run, configuration or migration notes, and screenshots for visible frontend changes. Link related issues or incident context when available.

## Security & Configuration Tips

Do not commit `.env`, generated databases, logs, or probe output. Treat resolver lists, polling intervals, ports, and database connection settings as configuration, not hard-coded deployment assumptions.
