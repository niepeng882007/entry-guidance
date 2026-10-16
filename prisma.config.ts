import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Generation and Next builds do not require database or DDL credentials.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
