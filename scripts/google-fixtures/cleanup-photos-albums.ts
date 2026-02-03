import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const REQUIRED_ENV_VARS = [
  'E2E_GOOGLE_CLIENT_ID',
  'E2E_GOOGLE_CLIENT_SECRET',
  'E2E_GOOGLE_PHOTOS_REFRESH_TOKEN',
];

async function main() {
  const missing = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
      console.error("Missing:", missing);
      process.exit(1);
  }

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
  const refreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN!;

  const auth = new OAuth2Client(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const { token } = await auth.getAccessToken();

  if (!token) {
      console.error("Failed to get access token");
      process.exit(1);
  }

  // 1. List Albums
  console.log("Listing albums...");
  const listRes = await fetch('https://photoslibrary.googleapis.com/v1/albums?pageSize=50', {
      headers: { Authorization: `Bearer ${token}` }
  });
  const listData = await listRes.json();
  const albums = listData.albums || [];
  
  const sandboxes = albums.filter((a: any) => a.title.startsWith("Sandbox_"));
  console.log(`Found ${sandboxes.length} Sandbox albums.`);

  for (const album of sandboxes) {
      console.log(`Cleaning album: ${album.title} (${album.id})`);
      
      // Empty It
      try {
          // Check items first
          const searchRes = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ albumId: album.id, pageSize: 100 })
          });
          const searchData = await searchRes.json();
          const items = searchData.mediaItems || [];
          
          if (items.length > 0) {
              const ids = items.map((i: any) => i.id);
              console.log(`  Removing ${ids.length} items...`);
              const removeRes = await fetch(`https://photoslibrary.googleapis.com/v1/albums/${album.id}:batchRemoveMediaItems`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ mediaItemIds: ids })
              });
              
              if (removeRes.ok) {
                  console.log("  ✅ Items removed.");
              } else {
                  console.error("  ❌ Failed to remove items:", await removeRes.text());
              }
          } else {
              console.log("  (Empty)");
          }
          
          // Cannot Delete.
          // Rename?
          // albums.patch not supported for title in v1? (Only cover photo)
          // Documentation says "You cannot update the title of an album created by your app." ? Or maybe you can?
          // Let's try to rename to "[EMPTY] ..." just to see.
          // PATCH https://photoslibrary.googleapis.com/v1/albums/{albumId}
          // body: { title: "..." }
          // query: updateMask=title
          /*
          const patchRes = await fetch(`https://photoslibrary.googleapis.com/v1/albums/${album.id}?updateMask=title`, {
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: `[CLEANED] ${album.title}` })
          });
          // This usually fails or isn't supported. 
          */

      } catch (e: any) {
          console.error(`  Error cleaning ${album.id}:`, e.message);
      }
  }
}

main();
