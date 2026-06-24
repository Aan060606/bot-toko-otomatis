function createMockCtx({ userId = 111111, chatId = userId, text = '' } = {}) {
  const replies = [];
  const sentMessages = [];
  const editedMessages = [];

  return {
    from: { id: userId, first_name: 'QA User', username: 'qa_user' },
    chat: { id: chatId },
    message: { message_id: 123, text },
    replies,
    telegram: {
      sendMessage: jest.fn(async (...args) => {
        sentMessages.push(args);
        return { message_id: sentMessages.length };
      }),
      editMessageText: jest.fn(async (...args) => {
        editedMessages.push(args);
        return true;
      })
    },
    reply: jest.fn(async (message, extra) => {
      replies.push({ message, extra });
      return { message_id: replies.length };
    }),
    replyWithMarkdown: jest.fn(async (message, extra) => {
      replies.push({ message, extra });
      return { message_id: replies.length };
    }),
    sentMessages,
    editedMessages
  };
}

module.exports = { createMockCtx };
