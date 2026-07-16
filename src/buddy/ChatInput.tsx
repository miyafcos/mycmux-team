import { useEffect, useRef, useState, type KeyboardEvent } from "react";

const MAX_CHAT_LENGTH = 500;

interface ChatInputProps {
  busy: boolean;
  onSubmit: (text: string) => void;
  onClose: () => void;
}

export function ChatInput({ busy, onSubmit, onClose }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = (): void => {
    if (busy) {
      return;
    }

    const normalizedText = value.trim().slice(0, MAX_CHAT_LENGTH);
    if (!normalizedText) {
      return;
    }

    onSubmit(normalizedText);
    setValue("");
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      textareaRef.current?.blur();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className={`buddy-widget__chat${busy ? " buddy-widget__chat--busy" : ""}`}>
      <textarea
        ref={textareaRef}
        className="buddy-widget__chat-textarea"
        value={value}
        disabled={busy}
        maxLength={MAX_CHAT_LENGTH}
        rows={1}
        autoFocus
        onBlur={onClose}
        onChange={(event) => setValue(event.target.value.slice(0, MAX_CHAT_LENGTH))}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
