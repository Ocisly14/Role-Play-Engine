# I18N Migration Example: ModLoadingModal

This document demonstrates a complete before/after migration of a React component to use i18next.

## Before Migration

**File:** `client/src/components/modals/ModLoadingModal.tsx`

```tsx
import React from "react";

interface ModLoadProgressData {
  stage: string;
  progress: number;
  message: string;
}

interface ModLoadingModalProps {
  loading: boolean;
  progress: ModLoadProgressData | null;
  onClose?: () => void;
}

export const ModLoadingModal: React.FC<ModLoadingModalProps> = ({
  loading,
  progress,
  onClose,
}) => {
  if (!loading) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm supports-[backdrop-filter]:bg-black/30 supports-[backdrop-filter]:backdrop-blur-sm flex items-center justify-center p-5">
      <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[600px] w-[90%] rounded-3xl p-12 supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold m-0 text-center w-full">
            Loading Module Data
          </h2>
        </div>

        {progress && (
          <>
            <div className="mb-5">
              <div className="flex justify-between mb-2.5 text-sm text-gray-700">
                <span>{progress.stage}</span>
                <span>{progress.progress}%</span>
              </div>
              <div className="w-full h-6 bg-gray-300 rounded-xl overflow-hidden border-2 border-gray-400">
                <div
                  className="h-full bg-gray-600 transition-all duration-300 flex items-center justify-center text-xs font-bold text-white"
                  style={{ width: `${progress.progress}%` }}
                >
                  {progress.progress >= 10 && `${progress.progress}%`}
                </div>
              </div>
            </div>

            <div className="text-center text-base min-h-[40px] flex items-center justify-center text-gray-700">
              {progress.message}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
```

**Issues:**
- ❌ "Loading Module Data" is hardcoded in English
- ❌ Cannot be translated to Chinese
- ❌ Progress messages from backend would need to be translated separately

---

## After Migration

**File:** `client/src/components/modals/ModLoadingModal.tsx`

```tsx
import React from "react";
import { useTranslation } from "react-i18next";

interface ModLoadProgressData {
  stage: string;
  progress: number;
  message: string;
}

interface ModLoadingModalProps {
  loading: boolean;
  progress: ModLoadProgressData | null;
  onClose?: () => void;
}

export const ModLoadingModal: React.FC<ModLoadingModalProps> = ({
  loading,
  progress,
  onClose,
}) => {
  const { t } = useTranslation('module');

  if (!loading) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm supports-[backdrop-filter]:bg-black/30 supports-[backdrop-filter]:backdrop-blur-sm flex items-center justify-center p-5">
      <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[600px] w-[90%] rounded-3xl p-12 supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold m-0 text-center w-full">
            {t('loading')}
          </h2>
        </div>

        {progress && (
          <>
            <div className="mb-5">
              <div className="flex justify-between mb-2.5 text-sm text-gray-700">
                <span>{progress.stage}</span>
                <span>{progress.progress}%</span>
              </div>
              <div className="w-full h-6 bg-gray-300 rounded-xl overflow-hidden border-2 border-gray-400">
                <div
                  className="h-full bg-gray-600 transition-all duration-300 flex items-center justify-center text-xs font-bold text-white"
                  style={{ width: `${progress.progress}%` }}
                >
                  {progress.progress >= 10 && `${progress.progress}%`}
                </div>
              </div>
            </div>

            <div className="text-center text-base min-h-[40px] flex items-center justify-center text-gray-700">
              {progress.message}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
```

**Changes Made:**
1. ✅ Added `import { useTranslation } from "react-i18next";`
2. ✅ Added `const { t } = useTranslation('module');` hook
3. ✅ Replaced `"Loading Module Data"` with `{t('loading')}`

**Translation Files:**

`client/src/i18n/locales/en/module.json`:
```json
{
  "loading": "Loading Module Data",
  ...
}
```

`client/src/i18n/locales/zh/module.json`:
```json
{
  "loading": "加载模组数据中",
  ...
}
```

---

## Testing

### English Output:
```
┌────────────────────────┐
│ Loading Module Data    │
├────────────────────────┤
│ Parsing scenarios      │
│ [████████░░] 80%      │
│ Loading NPC profiles   │
└────────────────────────┘
```

### Chinese Output (after switching language):
```
┌────────────────────────┐
│ 加载模组数据中         │
├────────────────────────┤
│ 解析场景              │
│ [████████░░] 80%      │
│ 加载NPC配置文件        │
└────────────────────────┘
```

---

## Benefits

1. ✅ **Automatic Translation**: Title changes based on user's language preference
2. ✅ **No Code Duplication**: Single component works for all languages
3. ✅ **Maintainable**: Translations managed in JSON files, not scattered in code
4. ✅ **Type Safe**: TypeScript + i18next provides autocomplete for translation keys
5. ✅ **Runtime Switching**: Language changes immediately without page reload

---

## Next Step: Full Backend Integration

For complete i18n support, the `progress.stage` and `progress.message` should also come from translation keys:

**Backend:**
```typescript
// Send translation keys instead of hardcoded messages
socket.emit('moduleLoadProgress', {
  stageKey: 'module.stages.parsingScenarios',
  progress: 80,
  messageKey: 'module.messages.loadingNPCs'
});
```

**Frontend:**
```tsx
<span>{t(progress.stageKey)}</span>
<div>{t(progress.messageKey)}</div>
```

This ensures complete internationalization of the entire loading flow.

---

## Migration Checklist for Other Components

When migrating any component:

- [ ] Import `useTranslation` hook
- [ ] Call `const { t } = useTranslation('namespace')` at component top
- [ ] Identify all hardcoded strings
- [ ] Replace each string with `{t('key.path')}`
- [ ] Add translation to both `en/[namespace].json` and `zh/[namespace].json`
- [ ] Test in both English and Chinese
- [ ] Verify no layout breaks with different text lengths
- [ ] Check console for missing key warnings
