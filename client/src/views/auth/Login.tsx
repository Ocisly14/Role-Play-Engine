import { FrameImage } from "../../components/FrameImage";
import { LoginForm } from "../../components/auth/LoginForm";
import { LanguageToggle } from "../../components/layout/LanguageToggle";
import { useAppSettings } from "../../contexts/AppSettingsContext";
import { useBackgroundImage } from "../../hooks/useBackgroundImage";

export default function Login() {
  // Set background image supporting multiple formats (png, jpeg, jpg)
  useBackgroundImage("background", true);
  const { language, handleLanguageChange } = useAppSettings();

  return (
    <div className="auth-page">
      <div className="auth-frame">
        <FrameImage />
        <div className="auth-container">
          <LoginForm />
        </div>
      </div>
      <LanguageToggle
        language={language}
        onLanguageChange={handleLanguageChange}
      />
    </div>
  );
}
