import { useEffect } from 'react';
import { findAvailableImage } from '../utils/imageLoader';

/**
 * Hook to set the body background image, supporting multiple formats (png, jpeg, jpg)
 * @param imageName - The base name of the image (e.g., 'background')
 * @param enabled - Whether to apply the background (default: true)
 */
export function useBackgroundImage(imageName: string = 'background', enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let isMounted = true;

    const setBackground = async () => {
      try {
        const imageUrl = await findAvailableImage(imageName);
        if (isMounted) {
          document.body.style.backgroundImage = `url('${imageUrl}')`;
          document.body.style.backgroundSize = "cover";
          document.body.style.backgroundPosition = "center";
          document.body.style.backgroundRepeat = "no-repeat";
          document.body.style.backgroundAttachment = "fixed";
        }
      } catch (error) {
        console.error(`Failed to load background image: ${imageName}`, error);
        // Fallback to default
        if (isMounted) {
          document.body.style.backgroundImage = `url('/asset/${imageName}.png')`;
        }
      }
    };

    setBackground();

    return () => {
      isMounted = false;
    };
  }, [imageName, enabled]);
}
