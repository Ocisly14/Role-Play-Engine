import { useEffect } from "react";
import { setBackgroundWithTransition } from "../utils/backgroundTransition";
import { findAvailableImage } from "../utils/imageLoader";

/**
 * Hook to set the body background image, supporting multiple formats (png, jpeg, jpg)
 * @param imageName - The base name of the image (e.g., 'background')
 * @param enabled - Whether to apply the background (default: true)
 * @param useTransition - Whether to use transition animation (default: false for initial load)
 */
export function useBackgroundImage(
  imageName = "background",
  enabled = true,
  useTransition = false
) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let isMounted = true;

    const setBackground = async () => {
      try {
        const imageUrl = await findAvailableImage(imageName);
        if (isMounted) {
          setBackgroundWithTransition(imageUrl, useTransition);
        }
      } catch (error) {
        console.error(`Failed to load background image: ${imageName}`, error);
        // Fallback to default
        if (isMounted) {
          setBackgroundWithTransition(`/asset/${imageName}.png`, useTransition);
        }
      }
    };

    setBackground();

    return () => {
      isMounted = false;
    };
  }, [imageName, enabled, useTransition]);
}
