import { tvFeed } from '../../src/api/feed';
import { FeedScreen } from '../../src/components/FeedScreen';

export default function SeriesTab() {
  return <FeedScreen load={tvFeed} tab="series" />;
}
