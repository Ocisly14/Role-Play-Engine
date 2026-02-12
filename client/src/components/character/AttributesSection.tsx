import React from "react";
import { useTranslation } from "react-i18next";

interface AttributesSectionProps {
  form: Record<string, string>;
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

export const AttributesSection: React.FC<AttributesSectionProps> = ({
  form,
  onChange,
  onRandomize,
}) => {
  const { t } = useTranslation('character');
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="section-title">{t('attributes.title')}</div>
        <button
          type="button"
          onClick={onRandomize}
          style={{
            padding: "8px 16px",
            backgroundColor: "#8b7355",
            color: "#f5f1e8",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: "bold",
          }}
        >
          🎲 {t('attributes.randomButton')}
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

      <h3>{t('attributes.derived')}</h3>
      <table>
        <tbody>
          <tr>
            <th>{t('attributes.HP')}</th>
            <td>
              <input
                name="HP"
                type="number"
                min="1"
                placeholder="10"
                value={form.HP || ""}
                onChange={(e) => onChange("HP", e.target.value)}
              />
            </td>
            <th>{t('attributes.SAN')}</th>
            <td>
              <input
                name="SAN"
                type="number"
                min="0"
                placeholder="60"
                value={form.SAN || ""}
                onChange={(e) => onChange("SAN", e.target.value)}
              />
            </td>
            <th>{t('attributes.MP')}</th>
            <td>
              <input
                name="MP"
                type="number"
                min="0"
                placeholder="10"
                value={form.MP || ""}
                onChange={(e) => onChange("MP", e.target.value)}
              />
            </td>
            <th>{t('attributes.LUCK')}</th>
            <td>
              <input
                name="LUCK"
                type="number"
                min="0"
                placeholder="50"
                value={form.LUCK || ""}
                onChange={(e) => onChange("LUCK", e.target.value)}
              />
            </td>
          </tr>
          <tr>
            <th>{t('attributes.MOV')}</th>
            <td>
              <input
                name="MOV"
                type="number"
                min="1"
                placeholder="8"
                value={form.MOV || ""}
                onChange={(e) => onChange("MOV", e.target.value)}
              />
            </td>
            <th>{t('attributes.BUILD')}</th>
            <td>
              <input
                name="BUILD"
                type="text"
                placeholder="0"
                value={form.BUILD || ""}
                onChange={(e) => onChange("BUILD", e.target.value)}
              />
            </td>
            <th>{t('attributes.DB')}</th>
            <td>
              <input
                name="DB"
                type="text"
                placeholder="0"
                value={form.DB || ""}
                onChange={(e) => onChange("DB", e.target.value)}
              />
            </td>
            <th>{t('attributes.ARMOR')}</th>
            <td>
              <input
                name="ARMOR"
                type="text"
                placeholder="0"
                value={form.ARMOR || ""}
                onChange={(e) => onChange("ARMOR", e.target.value)}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
};
