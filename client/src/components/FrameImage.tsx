import { useEffect, useState } from "react";
import { findAvailableImage } from "../utils/imageLoader";

interface FrameImageProps {
  className?: string;
  alt?: string;
  imageName?: string;
  formats?: string[];
}

export function FrameImage({
  className = "frame-image",
  alt = "TaleCraft Frame",
  imageName = "frame",
  formats = ["png", "jpeg", "jpg"],
}: FrameImageProps) {
  const [imageSrc, setImageSrc] = useState<string>("");

  useEffect(() => {
    findAvailableImage(imageName, formats).then(setImageSrc);
  }, [imageName, formats]);

  if (!imageSrc) {
    return null; // Loading state
  }

  return <img src={imageSrc} alt={alt} className={className} />;
}
