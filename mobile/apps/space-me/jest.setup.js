// AsyncStorage 原生模組在 Jest 內不存在，改用官方記憶體 mock
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
