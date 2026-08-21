/**
 * @hyagent/ui — 設計系統元件庫（前端共用）。
 *
 * 目前對外匯出對話 / 表單會用到的元件；其餘設計系統元件（layout、表格、
 * router 相依者…）已在 src/ 內，需要時再加進這裡與 tsconfig 的 include。
 */
export { default as Button } from './components/common/Button/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './components/common/Button/Button';

export { default as Badge } from './components/common/Badge/Badge';
export type {
  BadgeProps,
  StatusBadgeVariant,
  SimpleBadgeVariant,
} from './components/common/Badge/Badge';

export { default as Input } from './components/common/Input/Input';
export type { InputProps } from './components/common/Input/Input';

export { default as Textarea } from './components/common/Textarea/Textarea';
export type { TextareaProps } from './components/common/Textarea/Textarea';

export { default as Select } from './components/common/Select/Select';
export type { SelectProps } from './components/common/Select/Select';

export { default as Checkbox } from './components/common/Checkbox/Checkbox';
export type { CheckboxProps } from './components/common/Checkbox/Checkbox';

export { default as Radio } from './components/common/Radio/Radio';
export type { RadioProps } from './components/common/Radio/Radio';

export { default as MultiSelect } from './components/common/MultiSelect/MultiSelect';
export type {
  MultiSelectProps,
  MultiSelectOption,
} from './components/common/MultiSelect/MultiSelect';

export { default as DatePicker } from './components/common/DatePicker/DatePicker';
export type { DatePickerProps } from './components/common/DatePicker/DatePicker';

export { default as TimePicker } from './components/common/TimePicker/TimePicker';
export type { TimePickerProps } from './components/common/TimePicker/TimePicker';

export { default as Dialog } from './components/common/Dialog/Dialog';
export type { DialogProps, DialogConfirmVariant } from './components/common/Dialog/Dialog';

export { ToastProvider, useToast } from './components/common/Toast/Toast';
export type { ToastApi, ToastOptions, ToastVariant } from './components/common/Toast/Toast';

export { default as FileUploader } from './components/common/FileUploader/FileUploader';
export type { FileUploaderProps } from './components/common/FileUploader/FileUploader';
export type { CommittedFile, UploadResult } from './components/common/FileUploader/useFileUploader';

export { default as SchemaFormPreview } from './components/common/SchemaFormPreview/SchemaFormPreview';
export type {
  SchemaFormPreviewProps,
  PreviewDefinition,
  PreviewFieldSpec,
  PreviewFieldComponent,
} from './components/common/SchemaFormPreview/SchemaFormPreview';
