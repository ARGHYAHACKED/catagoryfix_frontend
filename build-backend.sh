#!/usr/bin/env bash
set -e

echo "=== Step 1: Installing pnpm globally ==="
npm install -g pnpm@9.15.0

echo "=== Step 2: Installing workspace dependencies ==="
pnpm install --frozen-lockfile

echo "=== Step 3: Generating Prisma Client and building packages ==="
pnpm --filter @catalogfix/database generate
pnpm --filter "./packages/*" build

echo "=== Step 4: Building all monorepo apps ==="
pnpm build

