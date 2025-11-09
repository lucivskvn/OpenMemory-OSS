#!/usr/bin/env python3

import sys
import os

# Prefer using an installed `openmemory` package; otherwise, fall back to the
# local `sdk-py` folder for development. Keep `# type: ignore` so static
# analyzers don't flag unresolved imports when the local SDK isn't installed.
try:
    from openmemory import OpenMemory, SECTORS  # type: ignore
except Exception:
    sdk_dir = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "sdk-py")
    )
    if sdk_dir not in sys.path:
        sys.path.insert(0, sdk_dir)
    try:
        from openmemory import OpenMemory, SECTORS  # type: ignore
    except Exception as e:
        raise ImportError(
            "Could not import the OpenMemory Python SDK.\n"
            "Options to fix:\n"
            "  1) Install the SDK into your environment: `pip install -e sdk-py` or `pip install openmemory`\n"
            "  2) Run this script from the repo root so the local `sdk-py` path resolves correctly.\n"
            "  3) Ensure the `sdk-py` folder exists at the repository root.\n"
        ) from e

def basic_example():
    print('🧠 OpenMemory Python SDK - Basic Example')
    print('=========================================')
    
    # Initialize client
    client = OpenMemory(
        base_url='http://localhost:8080',
        api_key=''  # Optional - set if your server requires auth
    )
    
    try:
        # Check server health
        print('1. Checking server health...')
        health = client.get_health()
        print('✅ Server status:', health)
        
        # Add some memories
        print('\n2. Adding memories...')
        memory1 = client.add("I went to Paris yesterday and loved the Eiffel Tower")
        print(f"✅ Memory stored in {memory1['primary_sector']} sector: {memory1['id']}")
        
        memory2 = client.add("I feel really excited about the new AI project")
        print(f"✅ Memory stored in {memory2['primary_sector']} sector: {memory2['id']}")
        
        memory3 = client.add("My morning routine: coffee, then check emails, then code")
        print(f"✅ Memory stored in {memory3['primary_sector']} sector: {memory3['id']}")
        
        # Query memories
        print('\n3. Querying memories...')
        results = client.query("Paris travel experience", k=5)
        print(f"✅ Found {len(results['matches'])} matching memories:")
        
        for i, match in enumerate(results['matches']):
            content_preview = match['content'][:50] + "..." if len(match['content']) > 50 else match['content']
            print(f"   {i+1}. [{match['primary_sector']}] {content_preview}")
            print(f"      Score: {match['score']:.3f}, Salience: {match['salience']:.3f}")
        
        # Update a memory
        if results['matches']:
            print('\n4. Updating best match...')
            memory_id = results['matches'][0]['id']
            original_content = results['matches'][0]['content']
            print(f"   Original: {original_content[:50]}...")
            
            # Update the memory with new content and tags
            updated_memory = client.update(
                memory_id, 
                content="I went to Paris yesterday and absolutely loved the Eiffel Tower - it was even more beautiful than I imagined!",
                tags=["travel", "paris", "eiffel-tower", "updated"],
                metadata={"updated": True, "original_length": len(original_content)}
            )
            print(f"✅ Memory updated: {updated_memory}")
        
        # Reinforce a memory
        if results['matches']:
            print('\n5. Reinforcing best match...')
            client.reinforce(results['matches'][0]['id'], 0.2)
            print('✅ Memory reinforced')
        
        # Get all memories
        print('\n6. Listing all memories...')
        all_memories = client.all(limit=10)
        print(f"✅ Total memories: {len(all_memories['items'])}")
        
    except Exception as error:
        print('❌ Error:', str(error))
        print('Make sure the OpenMemory server is running on port 8080')

if __name__ == '__main__':
    basic_example()
