import { KintoneRestAPIClient } from '@kintone/rest-api-client';

const client = new KintoneRestAPIClient({
    baseUrl: 'https://example.cybozu.com',
    auth: {
        apiToken: 'dummy-token'
    }
});

console.log('KintoneRestAPIClient created:', client);
