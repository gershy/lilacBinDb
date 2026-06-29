import './main.ts';
import { assertEqual, testRunner } from '../build/utils.test.ts';

// Type testing
(async () => {
  
  type Enforce<Provided, Expected extends Provided> = { provided: Provided, expected: Expected };
  
  type Tests = {
    1: Enforce<{ x: 'y' }, { x: 'y' }>,
  };
  if (0) ((v?: Tests) => void 0)();
  
})();

testRunner([
  
  {
    name: 'not implemented',
    fn: async () => {
      
      // TODO: Implement!
      assertEqual(null, null);
      
    }
  }
  
]);