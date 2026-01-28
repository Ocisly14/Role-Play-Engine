/**
 * Tries to load an image and returns a promise that resolves with the image URL if successful
 */
function tryLoadImage(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

/**
 * Finds the first available image format for a given image name
 * @param imageName - The base name of the image (e.g., 'frame', 'background')
 * @param formats - Array of formats to try (default: ['png', 'jpeg', 'jpg'])
 * @returns Promise that resolves with the URL of the first available image
 */
export async function findAvailableImage(
  imageName: string,
  formats: string[] = ['png', 'jpeg', 'jpg']
): Promise<string> {
  const basePath = `/asset/${imageName}`;
  
  for (const format of formats) {
    const src = `${basePath}.${format}`;
    try {
      await tryLoadImage(src);
      return src;
    } catch {
      // Continue to next format
      continue;
    }
  }
  
  // Fallback to png if all formats fail
  return `${basePath}.png`;
}

/**
 * Synchronously returns a default image URL (for CSS or immediate use)
 * The actual format detection happens asynchronously
 */
export function getDefaultImageUrl(imageName: string, format: string = 'png'): string {
  return `/asset/${imageName}.${format}`;
}
