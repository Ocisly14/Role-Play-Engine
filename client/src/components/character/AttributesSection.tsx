import type React from "react";
import { useTranslation } from "react-i18next";

interface AttributesSectionProps {
  form: Record<string, string>;
  derivedAttributes: Record<string, string | number>;
  onChange: (key: string, value: string) => void;
  onRandomize: () => void;
}

const ATTRIBUTES = [
  { key: "STR" },
  { key: "CON" },
  { key: "DEX" },
  { key: "APP" },
  { key: "POW" },
  { key: "SIZ" },
  { key: "INT" },
  { key: "EDU" },
  { key: "LCK" },
];

const DERIVED_ATTRIBUTES = [
  { key: "HP", type: "number", min: "1", placeholder: "10" },
  { key: "SAN", type: "number", min: "0", placeholder: "60" },
  { key: "MP", type: "number", min: "0", placeholder: "10" },
  { key: "LUCK", type: "number", min: "0", placeholder: "50" },
  { key: "MOV", type: "number", min: "1", placeholder: "8" },
  { key: "BUILD", type: "text", placeholder: "0" },
  { key: "DB", type: "text", placeholder: "0" },
  { key: "ARMOR", type: "text", placeholder: "0" },
] as const;

export const AttributesSection: React.FC<AttributesSectionProps> = ({
  form,
  derivedAttributes,
  onChange,
  onRandomize,
}) => {
  const { t } = useTranslation("character");
  return (
    <>
      <div className="attributes-header">
        <div className="section-title">{t("attributes.title")}</div>
        <button
          type="button"
          onClick={onRandomize}
          className="attributes-random-btn"
        >
          🎲 {t("attributes.randomButton")}
        </button>
      </div>

      <table>
        <thead>
          <tr>
            {ATTRIBUTES.map((attr) => (
              <th key={attr.key}>{t(`attributes.${attr.key}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {ATTRIBUTES.map((attr) => (
              <td key={attr.key}>
                <input
                  name={attr.key}
                  type="number"
                  min="1"
                  max="99"
                  placeholder="50"
                  value={form[attr.key] || ""}
                  onChange={(e) => onChange(attr.key, e.target.value)}
                />
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      <div className="section-title">{t("attributes.derived")}</div>
      <table>
        <thead>
          <tr>
            {DERIVED_ATTRIBUTES.map((attr) => (
              <th key={attr.key}>{t(`attributes.${attr.key}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {DERIVED_ATTRIBUTES.map((attr) => (
              <td key={attr.key}>
                <input
                  name={attr.key}
                  type={attr.type}
                  min={attr.min}
                  placeholder={attr.placeholder}
                  value={derivedAttributes[attr.key] ?? ""}
                  readOnly
                />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </>
  );
};
