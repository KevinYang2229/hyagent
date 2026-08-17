import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export interface MultiSelectOption {
  label: string;
  value: string;
}

export interface MultiSelectProps {
  /** 候選項目；提供時會顯示下拉建議清單 */
  options?: MultiSelectOption[];
  /** 目前已選的 value 陣列 */
  value: string[];
  /** 變更回呼 */
  onChange: (value: string[]) => void;
  /** placeholder 文字（無已選項目且無輸入時顯示） */
  placeholder?: string;
  /** 是否停用 */
  disabled?: boolean;
  /**
   * 是否允許新增不在 options 中的自由標籤；預設 false。
   * 開啟時 Enter 會以當前輸入文字作為新標籤加入。
   */
  allowCreate?: boolean;
  /** 顯示錯誤樣式（紅框） */
  error?: boolean;
  /** 額外 className */
  className?: string;
  /** 表單欄位 name（提供時會 render 一組隱藏 input 供 native form 蒐集） */
  name?: string;
}

/**
 * 多選輸入元件
 *
 * - 已選項目以標籤顯示，可按 ✕ 或 Backspace 移除
 * - 輸入文字會過濾 `options`，下拉顯示建議
 * - `allowCreate` 為 true 時，按 Enter 可加入自由輸入的新標籤
 */
function MultiSelect({
  options = [],
  value,
  onChange,
  placeholder = "",
  disabled = false,
  allowCreate = false,
  error = false,
  className = "",
  name,
}: MultiSelectProps) {
  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  /** 取得可顯示的建議項目（去除已選，並依輸入文字過濾） */
  const filteredOptions = useMemo(() => {
    const lowered = inputValue.trim().toLowerCase();
    return options
      .filter((opt) => !value.includes(opt.value))
      .filter(
        (opt) =>
          !lowered ||
          opt.label.toLowerCase().includes(lowered) ||
          opt.value.toLowerCase().includes(lowered),
      );
  }, [options, value, inputValue]);

  /** 取得已選項目對應的顯示文字（找不到時退回 value 本身） */
  const valueLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const opt of options) map.set(opt.value, opt.label);
    return map;
  }, [options]);

  // 點擊外部關閉下拉
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  /** 加入一個值（若不存在於 value 中） */
  const addValue = (next: string) => {
    const trimmed = next.trim();
    if (!trimmed) return;
    if (value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setInputValue("");
    setHighlightIndex(0);
  };

  /** 移除一個值 */
  const removeValue = (target: string) => {
    onChange(value.filter((v) => v !== target));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && filteredOptions[highlightIndex]) {
        addValue(filteredOptions[highlightIndex].value);
      } else if (allowCreate && inputValue.trim()) {
        addValue(inputValue);
      }
    } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
      removeValue(value[value.length - 1]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlightIndex((i) =>
        Math.min(i + 1, Math.max(filteredOptions.length - 1, 0)),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const handleContainerClick = () => {
    if (disabled) return;
    inputRef.current?.focus();
    setOpen(true);
  };

  const hasCreateOption = allowCreate && inputValue.trim().length > 0;
  const showDropdown =
    open && !disabled && (filteredOptions.length > 0 || hasCreateOption);

  return (
    <div
      ref={containerRef}
      className={`multi-select${error ? " error" : ""}${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`}
      onClick={handleContainerClick}
    >
      {value.map((v) => (
        <span key={v} className="multi-select-tag">
          <span>{valueLabelMap.get(v) ?? v}</span>
          <button
            type="button"
            className="multi-select-tag-remove"
            aria-label={`移除 ${valueLabelMap.get(v) ?? v}`}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              removeValue(v);
            }}
          >
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        className="multi-select-input"
        value={inputValue}
        placeholder={value.length === 0 ? placeholder : ""}
        disabled={disabled}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={showDropdown}
        onChange={(e) => {
          setInputValue(e.target.value);
          setOpen(true);
          setHighlightIndex(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />

      {showDropdown && (
        <ul
          id={listboxId}
          role="listbox"
          className="multi-select-dropdown"
          onMouseDown={(e) => e.preventDefault()}
        >
          {filteredOptions.length === 0 && allowCreate && inputValue.trim() && (
            <li
              role="option"
              aria-selected="false"
              className="multi-select-option create"
              onClick={() => addValue(inputValue)}
            >
              <i className="fa-solid fa-plus mr-1.5" />
              新增 “{inputValue.trim()}”
            </li>
          )}
          {filteredOptions.map((opt, idx) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={idx === highlightIndex}
              className={`multi-select-option${idx === highlightIndex ? " active" : ""}`}
              onMouseEnter={() => setHighlightIndex(idx)}
              onClick={() => addValue(opt.value)}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}

      {name &&
        value.map((v) => (
          <input key={v} type="hidden" name={name} value={v} />
        ))}
    </div>
  );
}

export default MultiSelect;
