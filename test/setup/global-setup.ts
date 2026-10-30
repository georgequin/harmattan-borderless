import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/**
 * Gives the suite a real, migrated PostgreSQL database.
 *
 * - If TEST_DATABASE_URL is set (e.g. in CI or inside docker compose), it is used as is.
 * - Otherwise a disposable postgres:16 container is started with Testcontainers,
 *   so `yarn test` needs nothing but a running Docker daemon.
 */
export default async function globalSetup(): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    useColimaSocketIfPresent();
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('harmattan_test')
      .withUsername('harmattan')
      .withPassword('harmattan')
      .start();
    globalThis.__PG_CONTAINER__ = container;
    url = container.getConnectionUri();
  }

  process.env.DATABASE_URL = url;
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  });
}

/** Testcontainers does not discover Colima's socket on its own. */
function useColimaSocketIfPresent(): void {
  const socket = join(homedir(), '.colima', 'default', 'docker.sock');
  if (!process.env.DOCKER_HOST && existsSync(socket)) {
    process.env.DOCKER_HOST = `unix://${socket}`;
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= '/var/run/docker.sock';
  }
}
