// @vitest-environment jsdom
import {beforeEach,describe,expect,it} from "vitest";
import {DEFAULT_CONVERSATION_HISTORY_MODE,normalizeConversationHistoryMode} from "../../src/lib/conversationHistory";
import {useSettingsStore} from "../../src/stores/settingsStore";
import {SETTINGS_STORE_VERSION} from "../../src/stores/settingsMigration";
beforeEach(()=>localStorage.clear());
describe("one persisted history mode",()=>{
  it("defaults to the approved guarded agent-wheel mode",()=>{expect(DEFAULT_CONVERSATION_HISTORY_MODE).toBe("agent-wheel");expect(useSettingsStore.getInitialState().conversationHistoryMode).toBe("agent-wheel");});
  it.each([undefined,null,"invalid",3,{}])("normalizes missing/invalid values %j",async(value)=>{localStorage.setItem("mycmux-settings",JSON.stringify({version:SETTINGS_STORE_VERSION,state:{conversationHistoryMode:value}}));await useSettingsStore.persist.rehydrate();expect(useSettingsStore.getState().conversationHistoryMode).toBe(DEFAULT_CONVERSATION_HISTORY_MODE);expect(normalizeConversationHistoryMode(value)).toBe(DEFAULT_CONVERSATION_HISTORY_MODE);});
  it.each(["legacy","manual","boundary","agent-wheel"] as const)("preserves an explicit %s choice and the independent button preference",async(mode)=>{useSettingsStore.getState().setConversationHistoryMode(mode);useSettingsStore.getState().setShowTerminalHistoryButton(false);await useSettingsStore.persist.rehydrate();expect(useSettingsStore.getState().conversationHistoryMode).toBe(mode);expect(useSettingsStore.getState().showTerminalHistoryButton).toBe(false);expect(JSON.parse(localStorage.getItem("mycmux-settings")!).version).toBe(SETTINGS_STORE_VERSION);});
});
