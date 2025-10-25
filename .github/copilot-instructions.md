# GitHub Copilot Instructions for Dobutsu Admin

## Project Context

This is a SvelteKit + Firebase admin application for managing inventory and orders for an online stationery store. The codebase uses TypeScript, Redux Toolkit for state management, and Firebase Firestore for real-time data synchronization.

## Code Style Guidelines

### General
- Use TypeScript for all new files
- Follow existing patterns in the codebase
- Use Biome for linting and formatting (not ESLint/Prettier)
- Run `npm run lint:fix` or `bun run lint:fix` before committing

### TypeScript
- Enable strict type checking
- Avoid `any` types - use proper interfaces or `unknown`
- Export types alongside functions
- Use type inference where obvious, explicit types for public APIs

### Svelte/SvelteKit
- Use `<script lang="ts">` for TypeScript support
- Prefer reactive statements (`$:`) for derived state
- Use SvelteKit's `$lib` alias for imports: `import { store } from '$lib/store'`
- Component filenames use PascalCase: `ComboBox.svelte`
- Route files use SvelteKit conventions: `+page.svelte`, `+layout.svelte`

### Redux/State Management
- All state changes must go through Redux actions
- Define actions using `createAction` from @reduxjs/toolkit
- Update reducers using Immer syntax (mutable drafts)
- Broadcast actions to Firestore for multi-user sync
- Pattern:
  ```typescript
  // 1. Define action
  export const action_name = createAction<PayloadType>("action_name");
  
  // 2. Add reducer case
  r.addCase(action_name, (state, action) => {
    // Modify state draft here
  });
  
  // 3. Dispatch with broadcast
  broadcast(firestore, $user.uid, action_name({...payload}));
  ```

### Firebase/Firestore
- Always use the Firebase v9+ modular API
- Import only what you need: `import { doc, setDoc } from 'firebase/firestore'`
- Handle errors gracefully with try/catch or .catch()
- Use `firestore` and `auth` exports from `$lib/firebase`
- For development, consider using Firestore emulator (currently commented out)

## Architecture Patterns

### Adding a New Route
1. Create directory in `src/routes/` with route name
2. Add `+page.svelte` for the page content
3. Add `+page.ts` if you need load functions
4. Use layout for shared authentication/structure

### Adding New Inventory Fields
1. Update `Item` interface in `src/lib/inventory.ts`
2. Add update action if needed (or use `update_field`)
3. Update relevant components (`InventoryRow.svelte`, etc.)
4. Update CSV export in `/csv` route if field should be exported

### Adding New State
1. Create new slice in `src/lib/` (e.g., `reports.ts`)
2. Define state interface and actions
3. Create reducer with `createReducer`
4. Add to store in `src/lib/store.ts`
5. Access via `$store.yourSlice` in components

## Common Tasks

### Running the Application
```bash
# Development
bun dev  # or npm run dev

# Build
bun run build  # or npm run build

# Deploy
firebase deploy --only hosting
```

### Code Quality
```bash
# Lint and format
bun run lint:fix  # or npm run lint:fix

# Type check
bun run check  # or npm run check

# Test
bun test  # or npm test
```

### Working with Git
- This repository was extracted from a monorepo using `git subtree split`
- Full git history is preserved
- Commit messages should be descriptive
- Use conventional commit format when possible

## Security Best Practices

### DO NOT:
- Commit API keys or secrets (Firebase config is already public, but avoid adding more)
- Hardcode credentials
- Expose admin-only features to unauthenticated users
- Trust client-side data without validation

### DO:
- Validate all user inputs
- Check authentication state before sensitive operations
- Use Firestore security rules (separate project)
- Sanitize data before displaying
- Handle errors without exposing system details

## Testing Guidelines

### Unit Tests
- Place tests in `tests/` directory
- Name files `*.test.ts`
- Test Redux reducers and business logic
- Mock Firebase services
- Run with: `bun test` or `npm test`

### Integration Tests
- Test component interactions
- Mock Firestore operations
- Verify state updates

### Example Test Structure
```typescript
import { describe, it, expect } from 'vitest';
import { reducer, action } from '$lib/myslice';

describe('myslice', () => {
  it('handles action correctly', () => {
    const state = reducer(initialState, action({...}));
    expect(state.field).toBe(expectedValue);
  });
});
```

## Debugging Tips

### Redux DevTools
- Redux DevTools Extension shows all actions
- Time-travel debugging available
- Inspect state at any point
- maxAge set to 100000 for long sessions

### Firestore Debugging
- Check browser console for Firestore errors
- Use Firebase Console to inspect data
- `logTime()` function shows performance metrics
- Unsynced actions counter indicates synchronization issues

### Common Issues
1. **Actions not syncing**: Check internet connection and Firestore rules
2. **Build errors**: Run `npm run check` for type errors
3. **Firebase config**: Ensure `.firebaserc` and `firebase.json` are correct
4. **Barcode scanner**: Needs HTTPS or localhost, requires camera permission

## Firebase Specifics

### Firestore Collections
- `broadcast`: Action log for state sync (timestamped, creator tracked)
- `dobutsu`: Orders and payments from PayPal integration
- `users`: Admin user activity tracking
- `jailed`: Quarantined invalid actions

### Firestore Patterns
```typescript
// Adding a document
import { addDoc, collection } from 'firebase/firestore';
await addDoc(collection(firestore, "myCollection"), data);

// Updating a document
import { doc, setDoc } from 'firebase/firestore';
await setDoc(doc(firestore, "myCollection", id), data);

// Listening to changes
import { onSnapshot, query, collection } from 'firebase/firestore';
onSnapshot(query(collection(firestore, "myCollection")), (snapshot) => {
  snapshot.docChanges().forEach(change => {
    // Handle change
  });
});
```

## Performance Considerations

### Bundle Size
- Lazy load heavy dependencies when possible
- Use dynamic imports for large components
- Consider code splitting for routes

### Firestore Queries
- Limit query results with `.limit()`
- Use pagination for large datasets
- Index frequently queried fields
- Avoid listening to entire collections

### Images
- Current implementation uses data URLs (suboptimal)
- Consider moving to Firebase Storage
- Implement image compression

## AI Assistant Specific Notes

### When Generating Code
1. Match existing code style exactly (check similar files)
2. Use TypeScript with proper types
3. Follow Redux patterns for state changes
4. Include error handling
5. Add comments for complex logic only
6. Don't over-engineer - keep it simple

### When Refactoring
1. Preserve functionality
2. Maintain backward compatibility
3. Update tests
4. Document breaking changes
5. Run linter after changes

### When Debugging
1. Check Redux DevTools first
2. Verify Firebase connection
3. Look for TypeScript errors
4. Check browser console
5. Verify authentication state

## Resources

- SvelteKit Docs: https://kit.svelte.dev/docs
- Firebase Web Docs: https://firebase.google.com/docs/web/setup
- Redux Toolkit: https://redux-toolkit.js.org/
- Biome: https://biomejs.dev/

## Questions?

- Check `DESIGN_OVERVIEW.md` for architecture details
- Review existing similar code for patterns
- Firebase config is in `src/lib/firebase.ts`
- State management is in `src/lib/store.ts` and slice files
