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
- **Backend**: Firebase (Firestore, Hosting, Authentication)
- **State Management**: Redux Toolkit integrated with Svelte stores
- **Build Tool**: Vite
- **Linter**: Biome
- **Package Manager**: Bun (with npm fallback)

## Quick Start

### Prerequisites
- Node.js 18+ or Bun 1.0+
- Firebase CLI: `npm install -g firebase-tools`
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/dobutsustationery/admin.git
cd admin

# Install dependencies (choose one)
bun install  # Recommended for speed
npm install  # Alternative
```

### Environment Configuration

This application supports three environments:
1. **Local** - Firebase emulators for offline development
2. **Staging** - Staging Firebase project (optional)
3. **Production** - Production Firebase project

#### Quick Setup

**Option 1: Local Development with Emulators (Recommended for development)**

```bash
# No additional setup needed - uses .env.local by default
npm run dev:local

# In a separate terminal, start the Firebase emulators
npm run emulators
```

**Option 2: Production Environment**

```bash
# Uses production Firebase project
npm run dev:production
```

**Option 3: Staging Environment**

```bash
# First, update .env.staging with your staging Firebase credentials
# Then run:
npm run dev:staging
```

#### Environment Switcher (Alternative Method)

If you prefer to use `npm run dev` without specifying the mode each time, you can use the environment switcher scripts to set a default:

```bash
# Switch to local environment
npm run env:local

# Switch to staging environment  
npm run env:staging

# Switch to production environment
npm run env:production

# Now just run dev normally - it will use the selected environment
npm run dev
```

This copies the selected environment configuration to `.env`, which becomes your default environment.

**Note:** The actual environment files are:
- Local: `.env.emulator` (used with `--mode emulator`)
- Staging: `.env.staging` (used with `--mode staging`)  
- Production: `.env.production` (used with `--mode production`)

The `.env.local` file is also present and loaded by Vite in all non-production modes.

#### Detailed Environment Setup

The application uses Vite's environment mode feature. Pre-configured environment files are provided:

- `.env.emulator` - Local emulator configuration (used with `--mode emulator`)
- `.env.local` - Vite's local override file (always loaded in non-production)
- `.env.staging` - Staging environment configuration (used with `--mode staging`)
- `.env.production` - Production environment configuration (used with `--mode production`)

To customize your environment:

1. Copy `.env.example` to `.env` if you want to override the defaults
2. Set `VITE_FIREBASE_ENV` to `local`, `staging`, or `production`
3. Configure the appropriate Firebase credentials

See `.env.example` for all available configuration options.

### Running the Application

**Local Development with Emulators:**

```bash
# Terminal 1: Start Firebase emulators
npm run emulators

# Terminal 2: Start dev server
npm run dev:local
# or simply
npm run dev
```

The application will be available at `http://localhost:5173`
The Firebase Emulator UI will be available at `http://localhost:4000`

**Development with Staging/Production:**

```bash
# Staging
npm run dev:staging

# Production
npm run dev:production
```

### Firebase Emulator Commands

```bash
# Start emulators
npm run emulators

# Export emulator data (save state)
npm run emulators:export

# Import previously exported data
npm run emulators:import
```

### Building for Production

```bash
# Build the application
npm run build
# or for specific environment
npm run build:local
npm run build:staging
npm run build:production

# Preview the production build
npm run preview
```

**For detailed environment configuration information, see [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md).**

### Deployment

```bash
# Login to Firebase (first time only)
firebase login

# Deploy to Firebase Hosting
firebase deploy --only hosting
```

## Development

### Code Quality

```bash
# Run linter
bun run lint
npm run lint

# Auto-fix linting issues
bun run lint:fix
npm run lint:fix

# Format code
bun run format
npm run format

# Type checking
bun run check
npm run check
```

### Testing

```bash
# Run tests
bun test
npm test

# Watch mode
bun run test:watch
npm run test:watch

# With coverage
bun test --coverage
npm test -- --coverage
```

## Project Structure

```
admin/
├── .github/              # GitHub configuration and Copilot instructions
├── src/
│   ├── lib/             # Shared components and utilities
│   │   ├── firebase.ts  # Firebase configuration
│   │   ├── store.ts     # Redux store setup
│   │   ├── inventory.ts # Inventory state management
│   │   ├── names.ts     # Names/values state management
│   │   └── *.svelte     # Reusable Svelte components
│   ├── routes/          # SvelteKit routes (pages)
│   │   ├── +layout.svelte      # Root layout with auth
│   │   ├── +page.svelte        # Home page (inventory entry)
│   │   ├── inventory/          # Inventory list page
│   │   ├── orders/             # Orders list page
│   │   ├── order/              # Order packing page
│   │   ├── csv/                # CSV export page
│   │   ├── names/              # Names management page
│   │   └── payments/           # Payments tracking page
│   ├── app.html         # HTML template
│   └── app.d.ts         # TypeScript definitions
├── static/              # Static assets
├── tests/               # Unit tests
├── firebase.json        # Firebase configuration
├── package.json         # Dependencies and scripts
└── vite.config.ts       # Vite configuration
```

## Features

### Barcode Scanning
- Scan JAN codes using device camera
- Supports QR codes and Data Matrix formats
- Auto-lookup in inventory database
- Audio feedback on successful scan

### Multi-User Synchronization
- Real-time updates across all connected admins
- Firebase-based action broadcasting
- Conflict resolution for concurrent edits
- Activity tracking and presence indicators

### Image Management
- Camera snapshot capability
- Google Custom Search integration
- Automatic description generation
- Manual image selection

## Documentation

- **[ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md)**: Comprehensive guide for environment configuration
- **[DESIGN_OVERVIEW.md](DESIGN_OVERVIEW.md)**: Architecture, data models, and technical details
- **[.github/copilot-instructions.md](.github/copilot-instructions.md)**: Guidelines for working with GitHub Copilot
- **[EXTRACTION_GUIDE.md](EXTRACTION_GUIDE.md)**: How this repository was extracted from the monorepo

## Contributing

1. Follow the code style guidelines in `.github/copilot-instructions.md`
2. Use TypeScript with proper typing
3. Write tests for new features
4. Run linter before committing: `bun run lint:fix`
5. Ensure all tests pass: `bun test`

## License

Proprietary - All rights reserved. See [LICENSE](LICENSE) file for details.

## Support

For issues or questions:
- Check the [DESIGN_OVERVIEW.md](DESIGN_OVERVIEW.md) for architecture details
- Review existing code for patterns
- Open an issue on GitHub
