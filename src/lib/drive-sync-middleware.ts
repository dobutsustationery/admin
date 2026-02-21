import type { Middleware } from "@reduxjs/toolkit";
import { getStoredToken, renameFile } from "./google-drive";

// Break circular dependency by avoiding GlobalState import
export const driveSyncMiddleware: Middleware<{}, any> =
  (storeAPI) => (next) => async (action) => {
    const result = next(action);
    const state = storeAPI.getState();

    // Sync Categorization to Drive Filename
    if (action.type === "photos/categorize_photo") {
      const { janCode, photo } = action.payload;

      // Safety check for state shape
      if (!state.photos || !state.photos.uploads) return result;

      // Check if uploaded
      const isUploaded =
        state.photos.uploads[photo.id]?.status === "completed" ||
        (photo.baseUrl && photo.baseUrl.includes("drive.google.com"));

      if (isUploaded) {
        const token = getStoredToken();
        if (token) {
          try {
            let fileId = "";
            const driveUrl =
              photo.baseUrl || state.photos.urlHistory[photo.id]?.[0];
            if (driveUrl) {
              const match = driveUrl.match(/id=([a-zA-Z0-9-_]+)/);
              if (match) fileId = match[1];
            }

            if (fileId) {
              const ext = photo.filename.split(".").pop() || "jpg";
              const safeId = photo.id.replace(/[^a-zA-Z0-9-_]/g, "");
              const newName = `${janCode}_${safeId}.${ext}`;

              console.log(`[DriveSync] Renaming ${fileId} to ${newName}`);
              renameFile(fileId, newName, token.access_token).catch((e: any) =>
                console.error("Drive Rename Failed", e),
              );
            }
          } catch (e) {
            console.error("Drive Sync Error", e);
          }
        }
      }
    }

    // Check Rename on Upload Completion (if already categorized)
    if (action.type === "photos/complete_upload") {
      const { id, permanentUrl } = action.payload;

      if (!state.photos || !state.photos.janCodeToPhotos) return result;

      // Check if categorized
      let janCode = "";
      const janMap = state.photos.janCodeToPhotos;
      if (janMap) {
        for (const [jan, photos] of Object.entries(janMap)) {
          // @ts-ignore
          if ((photos as any[]).some((p) => p.id === id)) {
            janCode = jan;
            break;
          }
        }
      }

      if (janCode) {
        const token = getStoredToken();
        if (token) {
          try {
            let fileId = "";
            if (permanentUrl) {
              const match = permanentUrl.match(/id=([a-zA-Z0-9-_]+)/);
              if (match) fileId = match[1];
            }

            if (fileId) {
              // Find item
              // @ts-ignore
              const item = state.photos.selected.find((p: any) => p.id === id);
              const ext = item
                ? item.filename.split(".").pop() || "jpg"
                : "jpg";
              const safeId = id.replace(/[^a-zA-Z0-9-_]/g, "");
              const newName = `${janCode}_${safeId}.${ext}`;

              console.log(
                `[DriveSync] Renaming completed upload ${fileId} to ${newName}`,
              );
              renameFile(fileId, newName, token.access_token).catch((e: any) =>
                console.error("Drive Rename Failed", e),
              );
            }
          } catch (e) {
            console.error("Drive Sync Error", e);
          }
        }
      }
    }

    return result;
  };
