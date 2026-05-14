/**
 * Utility functions for background image transitions
 */

/**
 * Preloads an image to ensure it's cached before display
 */
function preloadImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

/**
 * Sets background image with smooth crossfade transition
 * @param imageUrl - The URL of the background image
 * @param useTransition - Whether to use transition animation (default: true)
 * @param callback - Optional callback after transition completes
 */
export function setBackgroundWithTransition(
  imageUrl: string,
  useTransition = true,
  callback?: () => void
): void {
  if (!useTransition) {
    // Direct set without transition (for initial load)
    document.documentElement.style.setProperty(
      "--background-image",
      `url('${imageUrl}')`
    );
    document.documentElement.style.setProperty(
      "--background-image-new",
      "none"
    );
    document.body.classList.remove("background-transitioning");
    if (callback) {
      callback();
    }
    return;
  }

  // Preload new image first
  preloadImage(imageUrl)
    .then(() => {
      // Set new image to top layer
      document.documentElement.style.setProperty(
        "--background-image-new",
        `url('${imageUrl}')`
      );

      // Small delay to ensure CSS variable is set
      requestAnimationFrame(() => {
        // Trigger transition to show new layer
        document.body.classList.add("background-transitioning");

        // After transition completes, swap layers and reset
        setTimeout(() => {
          // Move new image to bottom layer
          document.documentElement.style.setProperty(
            "--background-image",
            `url('${imageUrl}')`
          );
          // Clear top layer
          document.documentElement.style.setProperty(
            "--background-image-new",
            "none"
          );
          // Remove transition class
          document.body.classList.remove("background-transitioning");

          if (callback) {
            callback();
          }
        }, 850); // Slightly longer than transition duration (800ms + 50ms buffer)
      });
    })
    .catch((error) => {
      console.error("Failed to preload background image:", error);
      // Fallback to direct set if preload fails
      document.documentElement.style.setProperty(
        "--background-image",
        `url('${imageUrl}')`
      );
      if (callback) {
        callback();
      }
    });
}
