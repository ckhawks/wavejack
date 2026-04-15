import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { useRoomStore } from "../../stores/roomStore";

export function RoomChat() {
  const { chatMessages, sendChat, userId } = useRoomStore();
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatMessages.length]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendChat(trimmed);
    setText("");
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        {chatMessages.length === 0 ? (
          <p className="py-4 text-center text-xs text-neutral-600">No messages yet</p>
        ) : (
          chatMessages.map((msg, i) => (
            <div key={i} className="mb-1.5">
              <span className={`text-xs font-medium ${msg.userId === userId ? "text-violet-400" : "text-emerald-400"}`}>
                {msg.userName}
              </span>
              <span className="ml-1.5 text-xs text-neutral-300">{msg.text}</span>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[#222] p-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Say something..."
          className="flex-1 rounded bg-[#111] px-3 py-1.5 text-xs text-white outline-none ring-1 ring-[#333] focus:ring-[#555]"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:text-white disabled:opacity-30"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
