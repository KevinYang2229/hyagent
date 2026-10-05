import { useRef, type FormEvent, type KeyboardEvent } from 'react';

/** 選字 Enter 必須留給輸入法，也不能觸發 form 的隱式送出。 */
export function useImeSubmit(submit: () => void) {
  const composing = useRef(false);
  const imeEnter = useRef(false);

  return {
    onCompositionStart() {
      composing.current = true;
    },
    onCompositionEnd() {
      composing.current = false;
    },
    onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      // Safari 可能在選字 Enter 的 keydown 前就發出 compositionend。
      imeEnter.current = event.key === 'Enter' && (
        composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
      );
      if (imeEnter.current) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!event.shiftKey) submit();
      }
    },
    onKeyUp() {
      imeEnter.current = false;
    },
    onSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!composing.current && !imeEnter.current) submit();
    },
  };
}
