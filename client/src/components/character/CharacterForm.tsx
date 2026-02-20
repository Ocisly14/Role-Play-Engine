import type React from "react";
import { useTranslation } from "react-i18next";
import { AttributeSelectorModal } from "../modals/AttributeSelectorModal";
import { AttributesSection } from "./AttributesSection";
import { IdentitySection } from "./IdentitySection";
import { NotesSection } from "./NotesSection";
import { SkillsSection } from "./SkillsSection";
import { WeaponsSection } from "./WeaponsSection";

interface CharacterFormProps {
  form: Record<string, string>;
  derivedAttributes: Record<string, string | number>;
  onChange: (key: string, value: string) => void;

  // Occupation
  occupations: any[];
  selectedOccupation: any;
  handleOccupationSelect: (occupation: any) => void;

  // Skills
  skillsState: any[];
  skillPointsUsage: {
    occupationalUsed: number;
    interestUsed: number;
    occupationalRemaining: number;
    interestRemaining: number;
  };
  occupationalPoints: number;
  interestPoints: number;

  // Weapons
  weaponsList: any[];

  // Attributes
  showAttributeSelector: boolean;
  setShowAttributeSelector: (show: boolean) => void;
  attributeOptions: any[];
  setAttributeOptions: (options: any[]) => void;
  handleRandomizeAttributes: () => void;
  handleSelectAttributeSet: (attributes: any) => void;

  // Saving
  saving: boolean;
  saveMessage: { type: "success" | "error"; text: string } | null;
  setSaveMessage: (
    message: { type: "success" | "error"; text: string } | null
  ) => void;
  handleCreateCharacter: () => void;

  // Navigation
  onCancel?: () => void;
}

export const CharacterForm: React.FC<CharacterFormProps> = ({
  form,
  derivedAttributes,
  onChange,
  occupations,
  selectedOccupation,
  handleOccupationSelect,
  skillsState,
  skillPointsUsage,
  occupationalPoints,
  interestPoints,
  weaponsList,
  showAttributeSelector,
  setShowAttributeSelector,
  attributeOptions,
  setAttributeOptions,
  handleRandomizeAttributes,
  handleSelectAttributeSet,
  saving,
  saveMessage,
  setSaveMessage,
  handleCreateCharacter,
  onCancel,
}) => {
  const { t } = useTranslation("character");
  return (
    <div className="sheet">
      <h1>{t("form.appTitle")}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleCreateCharacter();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
      >
        <div style={{ textAlign: "right", marginBottom: "6px" }}>
          {onCancel && (
            <button
              type="button"
              className="pill-btn"
              onClick={onCancel}
              style={{ background: "#eee" }}
            >
              ← {t("form.back")}
            </button>
          )}
        </div>

        {/* Identity Section */}
        <IdentitySection
          form={form}
          onChange={onChange}
          occupations={occupations}
          selectedOccupation={selectedOccupation}
          onSelectOccupation={handleOccupationSelect}
        />

        <hr />

        {/* Attributes Section */}
        <AttributesSection
          form={form}
          derivedAttributes={derivedAttributes}
          onChange={onChange}
          onRandomize={handleRandomizeAttributes}
        />

        <hr />

        {/* Skills Section */}
        <SkillsSection
          form={form}
          onChange={onChange}
          skillsState={skillsState}
          skillPointsUsage={skillPointsUsage}
          selectedOccupation={selectedOccupation}
          occupationalPoints={occupationalPoints}
          interestPoints={interestPoints}
        />

        <hr />

        {/* Weapons Section */}
        <WeaponsSection
          form={form}
          onChange={onChange}
          weaponsList={weaponsList}
        />

        <hr />

        {/* Notes Section */}
        <NotesSection form={form} onChange={onChange} />

        <hr />

        {/* Save Message */}
        {saveMessage && (
          <div
            style={{
              marginTop: "12px",
              padding: "12px",
              borderRadius: "4px",
              backgroundColor:
                saveMessage.type === "success" ? "#d4edda" : "#f8d7da",
              color: saveMessage.type === "success" ? "#155724" : "#721c24",
              border: `1px solid ${
                saveMessage.type === "success" ? "#c3e6cb" : "#f5c6cb"
              }`,
            }}
          >
            {saveMessage.text}
          </div>
        )}

        {/* Submit Button */}
        <div
          style={{
            marginTop: "20px",
            textAlign: "center",
            display: "flex",
            gap: "12px",
            justifyContent: "center",
          }}
        >
          {saveMessage && (
            <button
              className="pill-btn"
              type="button"
              onClick={() => setSaveMessage(null)}
              style={{
                background: "#8b7355",
                borderColor: "#8b7355",
                color: "#f5f1e8",
              }}
            >
              {t("form.clearMessage")}
            </button>
          )}
          <button className="pill-btn" type="submit" disabled={saving}>
            {saving ? t("form.submitting") : `🎲 ${t("form.submit")}`}
          </button>
        </div>
      </form>

      {/* Attribute Selector Modal */}
      <AttributeSelectorModal
        open={showAttributeSelector}
        onClose={() => {
          setShowAttributeSelector(false);
          setAttributeOptions([]);
        }}
        onSelectAttributes={handleSelectAttributeSet}
        age={Number(form.age) || undefined}
        initialOptions={attributeOptions}
      />
    </div>
  );
};
