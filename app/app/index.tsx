import { Text, View } from 'react-native';
import { Mascot } from '@/brand/Mascot';

export default function Index() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <Mascot pose="wave" size={120} />
      <Text>門市小幫手</Text>
    </View>
  );
}
