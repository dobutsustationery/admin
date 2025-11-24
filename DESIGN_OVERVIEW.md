# Dobutsu Stationery Admin - Design Overview

## Project Overview

This is an admin portal for managing inventory, orders, and payments for Dobutsu Stationery, an online stationery store specializing in unique items from Japan. The application is built with SvelteKit and Firebase, providing real-time synchronization across multiple admin users.

## Technology Stack

### Frontend
- **SvelteKit**: Modern framework for building reactive web applications
- **TypeScript**: Type-safe JavaScript with enhanced developer experience
- **Redux Toolkit**: State management with Redux integrated into Svelte stores
- **Svelte Firebase Auth**: Authentication components for Firebase
- **ZXing Library**: Barcode scanning functionality for inventory management

### Backend & Infrastructure
- **Firebase**:
  - **Firestore**: Real-time NoSQL database for inventory, orders, and user data
  - **Authentication**: Google OAuth for admin user authentication
  - **Hosting**: Static site hosting for the built application
  - **Firestore Broadcast System**: Real-time action synchronization across clients

### Build & Development Tools
- **Vite**: Fast build tool and development server
- **Biome**: Fast linter and formatter (replacing ESLint/Prettier)
- **Vitest**: Unit testing framework
- **Bun/NPM**: Package managers (Bun recommended for speed)

## Architecture

### State Management

The application uses a unique Redux-Svelte hybrid approach:

1. **Redux Store** (`src/lib/store.ts`): Central state management using Redux Toolkit
2. **Svelte Store Enhancer**: Wraps Redux store to make it reactive in Svelte components
3. **State Slices**:
   - `inventory`: Manages inventory items and quantities
   - `names`: Stores frequently-used values (HS codes, subtypes, etc.)
   - `history`: Logs all state changes for debugging

### Real-Time Synchronization

The application uses a broadcast pattern for multi-user synchronization:

1. **Action Broadcasting** (`src/lib/redux-firestore.ts`):
   - All state-changing actions are broadcast to Firestore
   - Each action is stored with timestamp and user ID
   - Other connected clients receive and replay actions

2. **Action Execution**:
   - Actions execute locally immediately (optimistic updates)
   - Actions are confirmed when Firestore acknowledges them
   - Unsynced actions counter shows pending synchronizations

3. **Conflict Handling**:
   - Invalid actions are moved to a "jailed" collection
   - Example: Prevents duplicate retype_item actions with same key

### Data Models

#### Inventory Item
```typescript
interface Item {
  janCode: string;      // Japanese Article Number barcode
  subtype: string;      // Product variant
  description: string;  // Item description
  hsCode: string;       // Harmonized System code for customs
  image: string;        // Product image URL
  qty: number;          // Quantity in stock
  pieces: number;       // Items per package
  shipped: number;      // Quantity already shipped
}
```

#### Order
```typescript
interface OrderInfo {
  id: string;           // Order ID
  date: Date;           // Order date
  email?: string;       // Customer email
  product?: string;     // Product name
  items: LineItem[];    // Items in order
}
```

## Application Routes

### `/` (Home/Inventory Entry)
- Barcode scanning interface
- Add new items to inventory
- Image search integration for product photos
- Auto-suggest for HS codes, subtypes, etc.

### `/inventory`
- View all current inventory
- Edit item details inline
- Shows quantity, shipped, and remaining stock
- Sortable and filterable table

### `/orders`
- List all orders from PayPal/Firestore
- Click to pack an order
- Integration with payment system

### `/order?orderId=...`
- Pack a specific order
- Scan items to add to order
- Auto-track shipped quantities
- Retype items if needed (variant selection)

### `/csv`
- Export inventory to CSV format
- Useful for customs declarations

### `/names`
- Manage frequently-used values
- Add/remove HS codes, subtypes, etc.
- Shows usage statistics

### `/payments`
- View payment transactions
- Monitor PayPal integration

## Key Features

### Barcode Scanning
- Uses device camera to scan JAN codes
- Supports QR codes and Data Matrix formats
- Auto-lookup in inventory
- Beep confirmation sound

### Image Management
- Snapshot from camera
- Google Custom Search integration
- Common substring algorithm for auto-description
- Manual image selection from search results

### Multi-User Coordination
- Real-time updates across all connected admins
- Activity tracking with timestamps
- User presence indicators

## Firebase Configuration

### Firestore Collections

1. **`broadcast`**: Action log for state synchronization
   - Fields: type, payload, timestamp, creator
   
2. **`dobutsu`**: Order and payment data
   - Payment information from PayPal
   - Order details and line items

3. **`users`**: Admin user tracking
   - Last activity timestamp
   - User profile information

4. **`jailed`**: Invalid actions quarantine

### Hosting Configuration
- Static adapter for SvelteKit
- Build output: `build/` directory
- Clean URLs enabled
- No trailing slashes

## Development Workflow

### Setup
```bash
# Install dependencies (choose one)
bun install  # Recommended
npm install  # Alternative

# Start development server
bun dev
npm run dev
```

### Building
```bash
# Build for production
bun run build
npm run build

# Preview production build
bun run preview
npm run preview
```

### Code Quality
```bash
# Linting
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
```

### Deployment
```bash
# Deploy to Firebase
firebase deploy --only hosting
```

## Known Issues & TODOs

### Security Concerns
1. **API Keys in Code**: Firebase config is hardcoded in `src/lib/firebase.ts`
   - Consider using environment variables
   - Implement Firebase App Check for production

2. **Authentication**: Currently uses Google OAuth only
   - Consider adding email/password option
   - Implement proper role-based access control

### Feature Gaps

1. **Error Handling**:
   - TODO in +layout.svelte: Surface Firestore errors in UI
   - Network error recovery needs improvement

2. **Inventory Management**:
   - No bulk import functionality
   - Missing low-stock alerts
   - No inventory history/audit log

3. **Order Processing**:
   - No shipping label generation
   - Missing order status workflow
   - No customer notifications

4. **Reporting**:
   - Limited analytics
   - No sales reports
   - Missing inventory turnover metrics

### Performance Optimizations Needed

1. **Firestore Queries**:
   - No pagination on orders list
   - All inventory loaded at once
   - Consider implementing infinite scroll

2. **Image Handling**:
   - Images stored as data URLs (inefficient)
   - Should use Firebase Storage or CDN
   - No image compression

3. **Bundle Size**:
   - Redux Toolkit adds significant weight
   - Consider code splitting for routes
   - Lazy load barcode scanner

### Code Quality Improvements

1. **Type Safety**:
   - Some `any` types in store enhancer
   - Missing types in some Redux reducers

2. **Testing**:
   - Minimal unit test coverage (focused on utility functions)
   - E2E tests implemented with Playwright (see `e2e/` directory and `E2E_SETUP_SUMMARY.md`)
   - User story-based E2E testing with numbered screenshots
   - Missing integration tests for some Firebase operations

3. **Documentation**:
   - Component-level documentation needed
   - API documentation for Redux actions
   - Setup guide for new developers

## Recommended Next Steps

### High Priority
1. Move Firebase config to environment variables
2. Add comprehensive error handling and user feedback
3. Implement proper role-based access control
4. Add unit tests for Redux reducers and business logic

### Medium Priority
1. Optimize Firestore queries with pagination
2. Implement Firebase Storage for images
3. Add inventory alerts and notifications
4. Create admin dashboard with metrics

### Low Priority
1. Add bulk import/export functionality
2. Implement order status workflow
3. Add customer-facing order tracking
4. Create mobile-optimized views

## Architecture Decisions

### Why Redux + Svelte?
- Redux provides time-travel debugging and action logging
- Broadcast pattern requires serializable actions
- Redux DevTools integration helpful for debugging
- Svelte reactivity complements Redux well

### Why Firebase?
- Real-time synchronization out of the box
- Serverless architecture reduces operational complexity
- Built-in authentication
- Scalable without infrastructure management

### Why SvelteKit over React?
- Smaller bundle sizes
- Simpler component model
- Better performance
- Built-in routing and SSG/SSR support

## Contributing Guidelines

### Code Style
- Use Biome for linting and formatting
- TypeScript strict mode enabled
- Follow existing patterns for Redux actions
- Document complex business logic

### Git Workflow
- Feature branches from main
- Descriptive commit messages
- Test before committing
- Use provided extraction script for maintaining git history

### Adding Features
1. Define Redux actions in appropriate slice
2. Update TypeScript interfaces
3. Add component in `src/routes/` or `src/lib/`
4. Write tests for business logic
5. Update this design doc if architecture changes
