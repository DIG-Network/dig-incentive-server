import { getStoresList } from "../../utils/config";
import { DataStore } from "../../blockchain";

export const precacheStoreInfo = async () => {
  const storeList = getStoresList();
  for (const storeId of storeList) {
    console.log(`Precaching store info for ${storeId}`);
    const dataStore = await DataStore.from(storeId);
    await dataStore.fetchCoinInfo();
  }
};
