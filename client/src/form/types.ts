import type { ReactElement } from 'react';
import type { FieldSpec } from '@oa-agent/shared';

/**
 * registry 內每個欄位 renderer 收到的統一 props。
 *
 * 值的型別由 renderer 所在的 registry 決定：`fieldRegistry` 一律字串，
 * `arrayFieldRegistry`（多選）為 string[]。
 */
export interface FieldControlProps<V = string> {
  spec: FieldSpec;
  /** 欄位 key；需要 DOM name 的元件（如同組 Radio）用它當群組識別 */
  name?: string;
  /** 一律以字串傳遞（送出前由 form.engine coerce 回正確型別） */
  value: V;
  disabled?: boolean;
  onChange: (value: V) => void;
}

export type FieldRenderer = (props: FieldControlProps) => ReactElement;

/** 值為 string[] 的欄位 renderer（多選）；由 FormView 直接把原始陣列往返，不經字串化 */
export type ArrayFieldRenderer = (props: FieldControlProps<string[]>) => ReactElement;
