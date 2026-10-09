const ZH_MESSAGES = Object.freeze({
  idle: '貼上文字，再選擇需要的整理方式。',
  dirty: '文字或選項已變更，請重新整理。',
  running: '正在整理文字…',
  success: '整理完成。請確認結果後複製或下載。',
  copied: '已複製結果。',
  downloaded: '已準備下載 cleaned-text.txt。',
  CLIPBOARD_FAILED: '無法寫入剪貼簿，請選取結果後手動複製。',
  DOWNLOAD_FAILED: '無法下載檔案，請選取結果後手動複製。',
  empty: '整理後沒有文字。可關閉移除空行，或修改原文。',
  cancelled: '已取消，原文保留。',
  INPUT_TOO_LARGE: '文字超過 200,000 個 UTF-16 單位或 256 KiB，請分成較小段落。',
  INVALID_UNICODE: '文字含不完整的 Unicode 字元，請重新貼上原始文字。',
  INVALID_OPTIONS: '整理選項無效，請全部清除後重試。',
  UNSUPPORTED: '此瀏覽器缺少本機處理能力，請換用支援的瀏覽器。',
  TIMEOUT: '處理時間已超過上限。請縮小文字後再試。',
  WORKER_FAILED: '無法完成整理。請確認網頁程式已載入後再試。',
});

const EN_MESSAGES = Object.freeze({
  idle: 'Paste text and choose how to clean it.',
  dirty: 'The text or options changed. Clean it again.',
  running: 'Cleaning text…',
  success: 'Cleaning complete. Review the result, then copy or download.',
  copied: 'Result copied.',
  downloaded: 'cleaned-text.txt is ready to download.',
  CLIPBOARD_FAILED: 'Could not write to the clipboard. Select the result and copy it manually.',
  DOWNLOAD_FAILED: 'Could not download the file. Select the result and copy it manually.',
  empty: 'The cleaned result is empty. You can keep or remove empty lines, or edit the source.',
  cancelled: 'Cancelled. The source text is unchanged.',
  INPUT_TOO_LARGE: 'Text exceeds 200,000 UTF-16 code units or 256 KiB. Split it into smaller parts.',
  INVALID_UNICODE: 'Text contains an incomplete Unicode character. Paste the original text again.',
  INVALID_OPTIONS: 'The cleaning options are invalid. Clear everything and try again.',
  UNSUPPORTED: 'Text cleaning could not start. Check that JavaScript is enabled, or use a browser that supports local processing.',
  TIMEOUT: 'Processing took too long. Try a smaller amount of text.',
  WORKER_FAILED: 'Text cleaning could not be completed. Check that the page loaded correctly, then try again.',
});

export function getMessages(language) {
  return language === 'en' ? EN_MESSAGES : ZH_MESSAGES;
}
