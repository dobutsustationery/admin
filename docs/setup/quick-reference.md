# Environment Configuration - Quick Reference

## Three Ways to Use Environments

### 🚀 Method 1: Direct Mode Selection (Fastest)
```bash
npm run dev:local       # Local emulators
npm run dev:staging     # Staging cloud  
npm run dev:production  # Production cloud
```

### 🔄 Method 2: Environment Switcher (Persistent)
```bash
npm run env:local       # Set default to local
npm run dev             # Use the default
```

### ⚙️ Method 3: Manual .env File
```bash
cp .env.local .env      # Copy template
npm run dev             # Use .env
```

## Environment Summary

| Environment | Use Case | Data Location | Requires Internet |
|-------------|----------|---------------|-------------------|
| **Local** | Development, testing | Local emulators | No (after setup) |
| **Staging** | QA, pre-production | Cloud (staging project) | Yes |
| **Production** | Live operations | Cloud (production) | Yes |

## File Structure

```
admin/
├── .env.example         # Documentation template
├── .env.emulator        # Local emulator config (tracked)
├── .env.local           # Vite's local override file (tracked, optional)
├── .env.staging        # Staging config template (tracked)
├── .env.production     # Production config (tracked)
├── .env                # Your active config (git-ignored)
├── firebase.json       # Includes emulator config
├── src/lib/firebase.ts # Multi-environment Firebase init
└── scripts/
    └── switch-env.js   # Environment switcher script
```

## Available Scripts

### Development
- `npm run dev` - Start dev server (uses .env or defaults)
- `npm run dev:local` - Start with local emulators
- `npm run dev:staging` - Start with staging
- `npm run dev:production` - Start with production

### Environment Switching
- `npm run env:local` - Set default to local
- `npm run env:staging` - Set default to staging
- `npm run env:production` - Set default to production

### Firebase Emulators
- `npm run emulators` - Start emulators
- `npm run emulators:export` - Save emulator data
- `npm run emulators:import` - Load saved data

### Building
- `npm run build:local` - Build for local
- `npm run build:staging` - Build for staging
- `npm run build:production` - Build for production

## Console Indicators

When the app starts, check the console to confirm your environment:

**Local:**
```
🔥 Firebase Environment: local
📦 Firebase Project: dobutsu-stationery-6b227
🔧 Connected to Firestore emulator at localhost:8080
🔧 Connected to Auth emulator at localhost:9099
```

**Staging/Production:**
```
🔥 Firebase Environment: production
📦 Firebase Project: dobutsu-stationery-6b227
```

## Quick Troubleshooting

| Problem | Solution |
|---------|----------|
| "Can't connect to Firestore" | Start emulators: `npm run emulators` |
| Environment not changing | Restart dev server |
| Staging vars missing | Edit `.env.staging` with your credentials |
| Production data in dev | Check console - verify environment |

## Learn More

📖 Full documentation: [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md)
