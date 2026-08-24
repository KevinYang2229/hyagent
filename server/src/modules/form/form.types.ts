/**
 * 六層 Form Definition 與 slot-filling 衍生型別。
 *
 * canonical 定義位於前後端共用套件 @hyagent/shared；此處原樣再匯出，
 * 維持 `@/modules/form/form.types` 既有 import 路徑不變。
 */
export type {
  JsonSchemaProperty,
  DataSchema,
  FieldComponent,
  FieldOption,
  FieldLink,
  FieldSpec,
  FieldSchema,
  LayoutSection,
  LayoutSchema,
  RuleOp,
  BusinessRule,
  ValidationSchema,
  WorkflowStep,
  WorkflowSchema,
  AgentSchema,
  WorkTimePolicy,
  PolicySchema,
  OARequestMapping,
  OAResponseMapping,
  OASchema,
  Definition,
  FormValues,
  FieldIssue,
  SlotStatus,
} from '@hyagent/shared';
