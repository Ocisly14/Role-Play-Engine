import React from "react";

interface AttributesSectionProps {
  form: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onRandomize: () => void;
}

const ATTRIBUTES = [
  { key: "STR", label: "Strength" },
  { key: "CON", label: "Constitution" },
  { key: "DEX", label: "Dexterity" },
  { key: "APP", label: "Appearance" },
  { key: "POW", label: "Power" },
  { key: "SIZ", label: "Size" },
  { key: "INT", label: "Intelligence" },
  { key: "EDU", label: "Education" },
  { key: "LCK", label: "Luck" },
];

export const AttributesSection: React.FC<AttributesSectionProps> = ({
  form,
  onChange,
  onRandomize,
}) => {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="section-title">Attributes</div>
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
          🎲 Random Attributes
        </button>
      </div>

      <table>
        <thead>
          <tr>
            {ATTRIBUTES.map((attr) => (
              <th key={attr.key}>{attr.label}</th>
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

      <h3>Derived Attributes</h3>
      <table>
        <tbody>
          <tr>
            <th>HP</th>
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
            <th>Sanity</th>
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
            <th>MP</th>
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
            <th>Luck</th>
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
            <th>Move</th>
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
            <th>Build</th>
            <td>
              <input
                name="BUILD"
                type="text"
                placeholder="0"
                value={form.BUILD || ""}
                onChange={(e) => onChange("BUILD", e.target.value)}
              />
            </td>
            <th>Damage Bonus</th>
            <td>
              <input
                name="DB"
                type="text"
                placeholder="0"
                value={form.DB || ""}
                onChange={(e) => onChange("DB", e.target.value)}
              />
            </td>
            <th>Armor</th>
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
