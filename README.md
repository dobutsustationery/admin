# Dobutsu Stationery Admin

Administration portal for managing inventory, sales, and operations for Dobutsu Stationery - an online stationery store specializing in unique items from Japan.

## Overview

This is a SvelteKit-based admin application with Firebase backend providing tools for:
- **Inventory Management**: Track and manage stationery products using barcode scanning
- **Order Processing**: Pack and ship orders
- **Sales Processing**: Handle transactions and payments via PayPal
- **Administration**: Manage store operations and settings

## Tech Stack

- **Frontend**: SvelteKit with TypeScript
- **Backend**: Firebase (Firestore, Hosting, Functions)
- **Build Tool**: Vite
- **Linter**: Biome
- **Package Manager**: Bun (with npm fallback)

## Getting Started

```bash
# Install dependencies
bun install
# or
npm install

# Run development server
bun dev
# or
npm run dev

# Build for production
bun run build
# or
npm run build
```

## Firebase Deployment

```bash
# Deploy to Firebase hosting
firebase deploy --only hosting
```
