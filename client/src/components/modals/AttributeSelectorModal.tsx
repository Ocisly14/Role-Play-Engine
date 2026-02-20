import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authFetch } from "../../utils/authFetch";

interface AttributeSet {
  STR: number;
  CON: number;
  DEX: number;
  APP: number;
  POW: number;
  SIZ: number;
  INT: number;
  EDU: number;
  LCK: number;
  HP: number;
  MP: number;
  SAN: number;
  MOV: number;
}

interface AttributeOption {
  id: number;
  attributes: AttributeSet;
}

interface AttributeSelectorModalProps {
  open: boolean;
  onClose: () => void;
  onSelectAttributes: (attributes: AttributeSet) => void;
  age?: number;
  initialOptions?: AttributeOption[];
}

export const AttributeSelectorModal: React.FC<AttributeSelectorModalProps> = ({
  open,
  onClose,
  onSelectAttributes,
  age,
  initialOptions = [],
}) => {
  const { t } = useTranslation(["character", "common"]);
  const [attributeOptions, setAttributeOptions] =
    useState<AttributeOption[]>(initialOptions);

  useEffect(() => {
    setAttributeOptions(initialOptions);
  }, [initialOptions]);

  if (!open) {
    return null;
  }

  const handleGenerateAnotherSet = async () => {
    if (attributeOptions.length >= 5) {
      return;
    }

    try {
      const response = await authFetch("/api/character/random-attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ age }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setAttributeOptions((prev) => [
          ...prev,
          { id: prev.length + 1, attributes: data.attributes },
        ]);
      } else {
        alert(
          `${t("character:attributes.selector.errors.generateFailed")}: ${
            data.error || t("common:error.generic")
          }`
        );
      }
    } catch (error) {
      console.error("Error generating random attributes:", error);
      alert(t("character:attributes.selector.errors.networkGenerateFailed"));
    }
  };

  const handleSelectAttributeSet = (attributes: AttributeSet) => {
    onSelectAttributes(attributes);
    setAttributeOptions([]);
  };

  const handleClose = () => {
    setAttributeOptions([]);
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: "20px",
      }}
    >
      <div
        style={{
          backgroundColor: "#f5f1e8",
          padding: "30px",
          borderRadius: "8px",
          maxWidth: "1200px",
          width: "95%",
          maxHeight: "90vh",
          overflow: "auto",
          border: "3px solid #8b7355",
          boxShadow: "0 8px 20px rgba(0, 0, 0, 0.4)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "20px",
          }}
        >
          <h2
            style={{
              margin: 0,
              color: "#3d2817",
              fontSize: "1.6rem",
            }}
          >
            🎲 {t("character:attributes.selector.title")}
          </h2>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "15px",
            }}
          >
            <span
              style={{
                fontSize: "0.9rem",
                color: "#666",
                fontWeight: "bold",
              }}
            >
              {t("character:attributes.selector.generatedCount", {
                count: attributeOptions.length,
                max: 5,
              })}
            </span>
            <button
              onClick={handleGenerateAnotherSet}
              disabled={attributeOptions.length >= 5}
              style={{
                padding: "8px 16px",
                backgroundColor:
                  attributeOptions.length >= 5 ? "#ccc" : "#8b7355",
                color: "#f5f1e8",
                border: "none",
                borderRadius: "4px",
                cursor:
                  attributeOptions.length >= 5 ? "not-allowed" : "pointer",
                fontSize: "0.9rem",
                fontWeight: "bold",
                transition: "background-color 0.2s",
              }}
              onMouseEnter={(e) => {
                if (attributeOptions.length < 5) {
                  e.currentTarget.style.backgroundColor = "#6b5a45";
                }
              }}
              onMouseLeave={(e) => {
                if (attributeOptions.length < 5) {
                  e.currentTarget.style.backgroundColor = "#8b7355";
                }
              }}
            >
              {attributeOptions.length >= 5
                ? t("character:attributes.selector.maxReached")
                : `🎲 ${t("character:attributes.selector.generateAnother")}`}
            </button>
          </div>
        </div>

        <div
          style={{
            padding: "12px",
            background: "#e8f4f8",
            border: "1px solid #5ba3c0",
            borderRadius: "4px",
            marginBottom: "15px",
            fontSize: "0.9rem",
            color: "#2c5f75",
            textAlign: "center",
          }}
        >
          {t("character:attributes.selector.hint")}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "15px",
            marginBottom: "20px",
          }}
        >
          {attributeOptions.map((option) => {
            const attrs = option.attributes;
            const total =
              (attrs.STR || 0) +
              (attrs.CON || 0) +
              (attrs.DEX || 0) +
              (attrs.APP || 0) +
              (attrs.POW || 0) +
              (attrs.SIZ || 0) +
              (attrs.INT || 0) +
              (attrs.EDU || 0) +
              (attrs.LCK || 0);

            return (
              <div
                key={option.id}
                onClick={() => handleSelectAttributeSet(attrs)}
                style={{
                  padding: "15px",
                  border: "2px solid #8b7355",
                  borderRadius: "6px",
                  cursor: "pointer",
                  backgroundColor: "#fff",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f0ebe0";
                  e.currentTarget.style.transform = "scale(1.02)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "#fff";
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                <div
                  style={{
                    fontWeight: "bold",
                    fontSize: "1.1rem",
                    marginBottom: "10px",
                    color: "#8b7355",
                    textAlign: "center",
                    borderBottom: "1px solid #ddd",
                    paddingBottom: "8px",
                  }}
                >
                  {t("character:attributes.selector.setLabel", {
                    id: option.id,
                  })}
                </div>

                <table style={{ width: "100%", fontSize: "0.85rem" }}>
                  <tbody>
                    <tr>
                      <td style={{ padding: "2px 4px", fontWeight: "500" }}>
                        STR:
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {attrs.STR}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "2px 4px", fontWeight: "500" }}>
                        CON:
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {attrs.CON}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "2px 4px", fontWeight: "500" }}>
                        DEX:
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {attrs.DEX}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "2px 4px", fontWeight: "500" }}>
                        APP:
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {attrs.APP}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "2px 4px", fontWeight: "500" }}>
                        POW:
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {attrs.POW}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "2px 4px", fontWeight: "500" }}>
                        SIZ:
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {attrs.SIZ}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "2px 4px", fontWeight: "500" }}>
                        INT:
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {attrs.INT}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "2px 4px", fontWeight: "500" }}>
                        EDU:
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {attrs.EDU}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "2px 4px", fontWeight: "500" }}>
                        LCK:
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {attrs.LCK}
                      </td>
                    </tr>
                    <tr style={{ borderTop: "1px solid #ddd" }}>
                      <td
                        style={{
                          padding: "4px 4px 2px",
                          fontWeight: "bold",
                        }}
                      >
                        {t("character:attributes.selector.total")}:
                      </td>
                      <td
                        style={{
                          padding: "4px 4px 2px",
                          textAlign: "right",
                          fontWeight: "bold",
                        }}
                      >
                        {total}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div
                  style={{
                    marginTop: "10px",
                    padding: "8px",
                    background: "#f9f9f9",
                    borderRadius: "4px",
                    fontSize: "0.75rem",
                    color: "#666",
                  }}
                >
                  <div>
                    <strong>HP:</strong> {attrs.HP}
                  </div>
                  <div>
                    <strong>MP:</strong> {attrs.MP}
                  </div>
                  <div>
                    <strong>SAN:</strong> {attrs.SAN}
                  </div>
                  <div>
                    <strong>MOV:</strong> {attrs.MOV}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <button
          onClick={handleClose}
          style={{
            width: "100%",
            padding: "12px 20px",
            backgroundColor: "#6b5a45",
            color: "#f5f1e8",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "1rem",
            fontWeight: "bold",
          }}
        >
          {t("common:button.cancel")}
        </button>
      </div>
    </div>
  );
};
